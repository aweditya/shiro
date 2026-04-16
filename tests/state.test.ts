import assert from "node:assert/strict";
import { after, beforeEach, describe, it, mock } from "node:test";
import {
  __resetStateForTests,
  addPendingApproval,
  attachTelegramMessage,
  clearBinding,
  consumePhonePromptPending,
  correlationKey,
  findPendingByCorrelation,
  findSessionByPrefix,
  getActiveSessions,
  getAllBindings,
  getBinding,
  getBindingByTarget,
  getPendingApproval,
  getPendingApprovals,
  getSession,
  hasAttemptedAutoBind,
  markAutoBindAttempted,
  markPhonePromptPending,
  popRecentApproval,
  pruneStaleSessions,
  renameSession,
  resolvePendingApproval,
  setBinding,
  setSessionTask,
  upsertSession,
} from "../src/state.js";
import type { ApprovalDecision } from "../src/types.js";

beforeEach(() => {
  __resetStateForTests();
});

describe("upsertSession", () => {
  it("creates a new session on first call", () => {
    const session = upsertSession("claude", "sess-1", "/Users/a/proj");
    assert.equal(session.id, "sess-1");
    assert.equal(session.agent, "claude");
    assert.equal(session.label, "proj");
    assert.equal(session.cwd, "/Users/a/proj");
    assert.ok(session.lastSeen > 0);
  });

  it("updates lastSeen and cwd on repeated calls, preserves label", () => {
    const first = upsertSession("claude", "sess-1", "/Users/a/proj");
    const firstSeen = first.lastSeen;
    // Wait at least a millisecond so lastSeen can change
    const later = firstSeen + 1;
    mock.timers.enable({ apis: ["Date"], now: later });
    const second = upsertSession("claude", "sess-1", "/Users/a/new-cwd");
    mock.timers.reset();
    assert.equal(second.id, first.id);
    assert.equal(second.cwd, "/Users/a/new-cwd");
    assert.equal(second.label, "proj", "label should not change on update");
    assert.ok(second.lastSeen >= firstSeen);
  });

  it("falls back to full cwd when basename is empty", () => {
    const session = upsertSession("codex", "sess-2", "");
    assert.equal(session.label, "");
  });
});

describe("getActiveSessions / pruneStaleSessions", () => {
  it("returns sessions newer than the cutoff", () => {
    upsertSession("claude", "fresh", "/a");
    assert.equal(getActiveSessions(60).length, 1);
  });

  it("excludes stale sessions from active list", () => {
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    upsertSession("claude", "old", "/a");
    mock.timers.setTime(1_000_000 + 120_000); // +120s
    assert.equal(
      getActiveSessions(60).length,
      0,
      "session older than 60s should not be active",
    );
    mock.timers.reset();
  });

  it("pruneStaleSessions removes stale entries and returns count", () => {
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    upsertSession("claude", "old", "/a");
    upsertSession("codex", "also-old", "/b");
    mock.timers.setTime(1_000_000 + 120_000);
    upsertSession("claude", "fresh", "/c"); // touch after advance
    const removed = pruneStaleSessions(60);
    assert.equal(removed, 2);
    assert.equal(getActiveSessions(60).length, 1);
    mock.timers.reset();
  });
});

describe("addPendingApproval / resolvePendingApproval", () => {
  function makeApproval(overrides: Partial<Parameters<typeof addPendingApproval>[0]> = {}) {
    let decision: ApprovalDecision | undefined;
    const approval = addPendingApproval({
      agent: "claude",
      sessionId: "s1",
      toolName: "Bash",
      toolInput: { command: "ls" },
      cwd: "/tmp",
      resolve: (d) => {
        decision = d;
      },
      ...overrides,
    });
    return { approval, getDecision: () => decision };
  }

  it("assigns a UUID and stores the approval", () => {
    const { approval } = makeApproval();
    assert.ok(approval.id.length > 0);
    assert.equal(getPendingApproval(approval.id), approval);
  });

  it("resolve invokes the callback exactly once with the decision", () => {
    const { approval, getDecision } = makeApproval();
    const resolved = resolvePendingApproval(approval.id, { approved: true });
    assert.ok(resolved);
    assert.deepEqual(getDecision(), { approved: true });
    // Second resolve is a no-op (approval already removed)
    const second = resolvePendingApproval(approval.id, { approved: false });
    assert.equal(second, undefined);
  });

  it("returns undefined when resolving a missing id", () => {
    assert.equal(
      resolvePendingApproval("does-not-exist", { approved: false }),
      undefined,
    );
  });

  it("removes the approval from pending on resolve", () => {
    const { approval } = makeApproval();
    resolvePendingApproval(approval.id, { approved: true });
    assert.equal(getPendingApproval(approval.id), undefined);
  });

  it("getPendingApprovals returns list sorted by receivedAt", () => {
    mock.timers.enable({ apis: ["Date"], now: 1000 });
    const first = addPendingApproval({
      agent: "claude",
      sessionId: "s1",
      toolName: "Bash",
      toolInput: {},
      cwd: "/a",
      resolve: () => {},
    });
    mock.timers.setTime(2000);
    const second = addPendingApproval({
      agent: "claude",
      sessionId: "s2",
      toolName: "Bash",
      toolInput: {},
      cwd: "/b",
      resolve: () => {},
    });
    const list = getPendingApprovals();
    assert.deepEqual(
      list.map((a) => a.id),
      [first.id, second.id],
    );
    mock.timers.reset();
  });
});

describe("correlationKey / findPendingByCorrelation", () => {
  it("produces a stable key regardless of property order in toolInput", () => {
    const k1 = correlationKey("claude", "s1", "Bash", { a: 1, b: 2 });
    const k2 = correlationKey("claude", "s1", "Bash", { a: 1, b: 2 });
    assert.equal(k1, k2);
  });

  it("produces different keys for different agents", () => {
    const a = correlationKey("claude", "s1", "Bash", { command: "ls" });
    const b = correlationKey("codex", "s1", "Bash", { command: "ls" });
    assert.notEqual(a, b);
  });

  it("produces different keys for different tool inputs", () => {
    const a = correlationKey("claude", "s1", "Bash", { command: "ls" });
    const b = correlationKey("claude", "s1", "Bash", { command: "rm -rf /" });
    assert.notEqual(a, b);
  });

  it("findPendingByCorrelation locates a pending approval by shape", () => {
    const approval = addPendingApproval({
      agent: "claude",
      sessionId: "s1",
      toolName: "Bash",
      toolInput: { command: "ls" },
      cwd: "/a",
      resolve: () => {},
    });
    const found = findPendingByCorrelation("claude", "s1", "Bash", {
      command: "ls",
    });
    assert.equal(found?.id, approval.id);
  });

  it("findPendingByCorrelation returns undefined on mismatch", () => {
    addPendingApproval({
      agent: "claude",
      sessionId: "s1",
      toolName: "Bash",
      toolInput: { command: "ls" },
      cwd: "/a",
      resolve: () => {},
    });
    assert.equal(
      findPendingByCorrelation("claude", "s1", "Bash", { command: "rm" }),
      undefined,
    );
  });
});

describe("recent approvals (PostToolUse correlation)", () => {
  it("stashes a resolved approval only if a Telegram message was attached", () => {
    const withMsg = addPendingApproval({
      agent: "claude",
      sessionId: "s1",
      toolName: "Bash",
      toolInput: { command: "ls" },
      cwd: "/a",
      resolve: () => {},
    });
    attachTelegramMessage(withMsg.id, 42, 99);
    resolvePendingApproval(withMsg.id, { approved: true });
    const found = popRecentApproval("claude", "s1", "Bash", { command: "ls" });
    assert.equal(found?.approval.id, withMsg.id);

    const noMsg = addPendingApproval({
      agent: "claude",
      sessionId: "s2",
      toolName: "Bash",
      toolInput: { command: "pwd" },
      cwd: "/b",
      resolve: () => {},
    });
    resolvePendingApproval(noMsg.id, { approved: true });
    assert.equal(
      popRecentApproval("claude", "s2", "Bash", { command: "pwd" }),
      undefined,
      "approval without telegramMessageId should not be stashed",
    );
  });

  it("popRecentApproval consumes the entry (one-shot)", () => {
    const a = addPendingApproval({
      agent: "claude",
      sessionId: "s1",
      toolName: "Bash",
      toolInput: { command: "ls" },
      cwd: "/a",
      resolve: () => {},
    });
    attachTelegramMessage(a.id, 42, 99);
    resolvePendingApproval(a.id, { approved: true });
    assert.ok(popRecentApproval("claude", "s1", "Bash", { command: "ls" }));
    assert.equal(
      popRecentApproval("claude", "s1", "Bash", { command: "ls" }),
      undefined,
    );
  });

  it("prunes entries older than the 5-minute TTL", () => {
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const a = addPendingApproval({
      agent: "claude",
      sessionId: "s1",
      toolName: "Bash",
      toolInput: { command: "ls" },
      cwd: "/a",
      resolve: () => {},
    });
    attachTelegramMessage(a.id, 42, 99);
    resolvePendingApproval(a.id, { approved: true });
    // Advance beyond TTL (5 min + 1s)
    mock.timers.setTime(1_000_000 + 5 * 60 * 1000 + 1000);
    assert.equal(
      popRecentApproval("claude", "s1", "Bash", { command: "ls" }),
      undefined,
    );
    mock.timers.reset();
  });
});

describe("attachTelegramMessage", () => {
  it("sets chat and message ids on a pending approval", () => {
    const a = addPendingApproval({
      agent: "claude",
      sessionId: "s1",
      toolName: "Bash",
      toolInput: {},
      cwd: "/a",
      resolve: () => {},
    });
    attachTelegramMessage(a.id, 42, 99);
    assert.equal(a.telegramChatId, 42);
    assert.equal(a.telegramMessageId, 99);
  });

  it("is a no-op for unknown approval ids", () => {
    assert.doesNotThrow(() => attachTelegramMessage("nope", 1, 2));
  });
});

describe("setSessionTask", () => {
  it("stores the prompt on the session and bumps lastSeen", () => {
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    upsertSession("claude", "s1", "/a");
    mock.timers.setTime(1_000_500);
    setSessionTask("s1", "refactor the auth middleware");
    const [session] = getActiveSessions(60);
    assert.equal(session?.currentTask, "refactor the auth middleware");
    assert.equal(session?.lastSeen, 1_000_500);
    mock.timers.reset();
  });

  it("is a no-op for unknown session ids", () => {
    assert.doesNotThrow(() => setSessionTask("nope", "x"));
  });
});

describe("renameSession", () => {
  it("renames by full id", () => {
    upsertSession("claude", "abc123def", "/a");
    const result = renameSession("abc123def", "my-project");
    assert.ok(result.ok);
    assert.equal(result.ok && result.session.label, "my-project");
  });

  it("renames by unique prefix", () => {
    upsertSession("claude", "abc123def", "/a");
    upsertSession("claude", "xyz987qrs", "/b");
    const result = renameSession("abc", "renamed");
    assert.ok(result.ok);
    assert.equal(result.ok && result.session.id, "abc123def");
  });

  it("returns not_found when no match", () => {
    upsertSession("claude", "abc123def", "/a");
    const result = renameSession("nothing", "x");
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, "not_found");
  });

  it("returns ambiguous when prefix matches multiple sessions", () => {
    upsertSession("claude", "abc111", "/a");
    upsertSession("claude", "abc222", "/b");
    const result = renameSession("abc", "x");
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, "ambiguous");
  });
});

describe("addPendingApproval task snapshot", () => {
  it("carries the optional task through to the approval", () => {
    const a = addPendingApproval({
      agent: "claude",
      sessionId: "s1",
      toolName: "Bash",
      toolInput: {},
      cwd: "/a",
      task: "the current task",
      resolve: () => {},
    });
    assert.equal(a.task, "the current task");
  });
});

describe("tmux bindings", () => {
  it("setBinding stores target + source and getBinding reads it back", () => {
    const binding = setBinding("sess-1", "main:0.0", "manual");
    assert.equal(binding.target, "main:0.0");
    assert.equal(binding.source, "manual");
    assert.ok(binding.boundAt > 0);
    assert.deepEqual(getBinding("sess-1"), binding);
  });

  it("setBinding overwrites an existing binding for the same session", () => {
    setBinding("sess-1", "main:0.0", "auto");
    const second = setBinding("sess-1", "work:1.0", "manual");
    assert.equal(getBinding("sess-1")?.target, "work:1.0");
    assert.equal(getBinding("sess-1")?.source, "manual");
    assert.equal(second.target, "work:1.0");
  });

  it("clearBinding removes the entry and returns whether it existed", () => {
    setBinding("sess-1", "main:0.0", "manual");
    assert.equal(clearBinding("sess-1"), true);
    assert.equal(getBinding("sess-1"), undefined);
    assert.equal(clearBinding("sess-1"), false);
  });

  it("getBindingByTarget finds the session bound to a tmux target", () => {
    setBinding("sess-1", "main:0.0", "auto");
    setBinding("sess-2", "work:1.0", "manual");
    assert.equal(getBindingByTarget("work:1.0")?.sessionId, "sess-2");
    assert.equal(getBindingByTarget("nope"), undefined);
  });

  it("getAllBindings returns every {sessionId, binding} pair", () => {
    setBinding("a", "ta:0.0", "auto");
    setBinding("b", "tb:0.0", "manual");
    const all = getAllBindings();
    assert.equal(all.length, 2);
    const ids = all.map((b) => b.sessionId).sort();
    assert.deepEqual(ids, ["a", "b"]);
  });

  it("__resetStateForTests clears all bindings", () => {
    setBinding("sess-1", "main:0.0", "auto");
    __resetStateForTests();
    assert.equal(getBinding("sess-1"), undefined);
    assert.equal(getAllBindings().length, 0);
  });
});

describe("auto-bind attempt tracking", () => {
  it("markAutoBindAttempted flips hasAttemptedAutoBind to true", () => {
    assert.equal(hasAttemptedAutoBind("sess-1"), false);
    markAutoBindAttempted("sess-1");
    assert.equal(hasAttemptedAutoBind("sess-1"), true);
  });

  it("attempt flag is per-session", () => {
    markAutoBindAttempted("sess-1");
    assert.equal(hasAttemptedAutoBind("sess-2"), false);
  });

  it("__resetStateForTests clears attempt flags", () => {
    markAutoBindAttempted("sess-1");
    __resetStateForTests();
    assert.equal(hasAttemptedAutoBind("sess-1"), false);
  });
});

describe("findSessionByPrefix", () => {
  it("matches by full id", () => {
    upsertSession("claude", "abc123def", "/a");
    const result = findSessionByPrefix("abc123def");
    assert.ok(result.ok);
    assert.equal(result.ok && result.session.id, "abc123def");
  });

  it("matches by unique prefix", () => {
    upsertSession("claude", "abc123def", "/a");
    upsertSession("claude", "xyz987qrs", "/b");
    const result = findSessionByPrefix("abc");
    assert.ok(result.ok);
    assert.equal(result.ok && result.session.id, "abc123def");
  });

  it("returns not_found when nothing matches", () => {
    upsertSession("claude", "abc123", "/a");
    const result = findSessionByPrefix("zzz");
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, "not_found");
  });

  it("returns ambiguous when prefix matches multiple", () => {
    upsertSession("claude", "abc111", "/a");
    upsertSession("claude", "abc222", "/b");
    const result = findSessionByPrefix("abc");
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, "ambiguous");
  });
});

describe("getSession", () => {
  it("returns the session for a known id", () => {
    upsertSession("claude", "s1", "/a");
    assert.equal(getSession("s1")?.id, "s1");
  });

  it("returns undefined for unknown ids", () => {
    assert.equal(getSession("nope"), undefined);
  });
});

describe("phone prompt pending", () => {
  it("consumePhonePromptPending returns true exactly once after marking", () => {
    markPhonePromptPending("sess-1");
    assert.equal(consumePhonePromptPending("sess-1"), true);
    assert.equal(
      consumePhonePromptPending("sess-1"),
      false,
      "second consume should be false (one-shot)",
    );
  });

  it("consumePhonePromptPending returns false when never marked", () => {
    assert.equal(consumePhonePromptPending("sess-x"), false);
  });

  it("__resetStateForTests clears pending flags", () => {
    markPhonePromptPending("sess-1");
    __resetStateForTests();
    assert.equal(consumePhonePromptPending("sess-1"), false);
  });
});

after(() => {
  mock.timers.reset();
});
