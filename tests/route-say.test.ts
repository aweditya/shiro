import "./env-setup.js";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { routeSayMessage } from "../src/telegram.js";
import {
  __resetStateForTests,
  consumePhonePromptPending,
  getBinding,
  setBinding,
  upsertSession,
} from "../src/state.js";

beforeEach(() => {
  __resetStateForTests();
});

interface FakeOpsCalls {
  paneExists: string[];
  sendKeys: Array<{ target: string; message: string }>;
}

function fakeOps(
  config: {
    paneExists?: (target: string) => Promise<boolean>;
    sendKeys?: (target: string, message: string) => Promise<void>;
  } = {},
): {
  ops: {
    paneExists: (target: string) => Promise<boolean>;
    sendKeys: (target: string, message: string) => Promise<void>;
  };
  calls: FakeOpsCalls;
} {
  const calls: FakeOpsCalls = { paneExists: [], sendKeys: [] };
  return {
    calls,
    ops: {
      paneExists: async (target) => {
        calls.paneExists.push(target);
        return config.paneExists ? config.paneExists(target) : true;
      },
      sendKeys: async (target, message) => {
        calls.sendKeys.push({ target, message });
        if (config.sendKeys) await config.sendKeys(target, message);
      },
    },
  };
}

describe("routeSayMessage", () => {
  it("returns no_binding when the session has no tmux binding", async () => {
    upsertSession("claude", "s1", "/a");
    const { ops } = fakeOps();
    const result = await routeSayMessage("s1", "hello", ops);
    assert.equal(result.kind, "no_binding");
    assert.equal(consumePhonePromptPending("s1"), false);
  });

  it("returns stale and clears the binding when the pane is gone", async () => {
    upsertSession("claude", "s1", "/a");
    setBinding("s1", "main:0.0", "manual");
    const { ops, calls } = fakeOps({ paneExists: async () => false });
    const result = await routeSayMessage("s1", "hello", ops);
    assert.equal(result.kind, "stale");
    assert.equal(result.kind === "stale" && result.target, "main:0.0");
    assert.equal(getBinding("s1"), undefined, "binding should be cleared");
    assert.equal(calls.sendKeys.length, 0, "must not attempt sendKeys");
    assert.equal(consumePhonePromptPending("s1"), false);
  });

  it("returns send_failed (with reason) when sendKeys throws", async () => {
    upsertSession("claude", "s1", "/a");
    setBinding("s1", "main:0.0", "manual");
    const { ops } = fakeOps({
      sendKeys: async () => {
        throw new Error("tmux: pane not found");
      },
    });
    const result = await routeSayMessage("s1", "hello", ops);
    assert.equal(result.kind, "send_failed");
    if (result.kind === "send_failed") {
      assert.equal(result.target, "main:0.0");
      assert.match(result.reason, /pane not found/);
    }
    assert.equal(
      consumePhonePromptPending("s1"),
      false,
      "must not flag phone-pending if send failed",
    );
  });

  it("sends keys, marks phone-pending, and returns sent on success", async () => {
    upsertSession("claude", "s1", "/a");
    setBinding("s1", "main:0.0", "manual");
    const { ops, calls } = fakeOps();
    const result = await routeSayMessage("s1", "type this", ops);
    assert.equal(result.kind, "sent");
    assert.equal(result.kind === "sent" && result.target, "main:0.0");
    assert.deepEqual(calls.sendKeys, [
      { target: "main:0.0", message: "type this" },
    ]);
    assert.equal(
      consumePhonePromptPending("s1"),
      true,
      "phone-pending should be flagged so Stop hook routes the reply",
    );
  });

  it("preserves the binding when sendKeys fails (so user can retry)", async () => {
    upsertSession("claude", "s1", "/a");
    setBinding("s1", "main:0.0", "manual");
    const { ops } = fakeOps({
      sendKeys: async () => {
        throw new Error("transient");
      },
    });
    await routeSayMessage("s1", "hi", ops);
    assert.equal(getBinding("s1")?.target, "main:0.0");
  });
});
