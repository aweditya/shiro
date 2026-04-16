import "./env-setup.js";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { Bot } from "grammy";
import { config } from "../src/config.js";
import { createHttpServer, shouldNotifyStop } from "../src/http-server.js";
import {
  __resetStateForTests,
  getActiveSessions,
  getPendingApprovals,
  resolvePendingApproval,
} from "../src/state.js";
import type { Session } from "../src/types.js";

interface FakeBotCalls {
  sendMessage: Array<{ chatId: number; text: string }>;
  editMessageText: Array<{ chatId: number; messageId: number; text: string }>;
}

function makeFakeBot(): { bot: Bot; calls: FakeBotCalls } {
  const calls: FakeBotCalls = { sendMessage: [], editMessageText: [] };
  let nextMessageId = 1;
  const bot = {
    api: {
      sendMessage: async (chatId: number, text: string) => {
        const message_id = nextMessageId++;
        calls.sendMessage.push({ chatId, text });
        return { chat: { id: chatId }, message_id };
      },
      editMessageText: async (
        chatId: number,
        messageId: number,
        text: string,
      ) => {
        calls.editMessageText.push({ chatId, messageId, text });
        return true as unknown as never;
      },
    },
  } as unknown as Bot;
  return { bot, calls };
}

const AUTH = `Bearer ${config.sharedSecret}`;

let server: ReturnType<typeof createHttpServer>;
let baseUrl: string;
let calls: FakeBotCalls;

before(async () => {
  const fake = makeFakeBot();
  calls = fake.calls;
  server = createHttpServer(fake.bot);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  __resetStateForTests();
  calls.sendMessage.length = 0;
  calls.editMessageText.length = 0;
});

// Wait up to `timeoutMs` for `check` to return truthy. Used to poll
// async side-effects like "approval registered" or "edit message sent".
async function waitFor(
  check: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor timed out");
}

describe("health endpoint", () => {
  it("returns 200 without auth", async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

describe("auth", () => {
  it("rejects /hooks/* with no Authorization header", async () => {
    const res = await fetch(`${baseUrl}/hooks/claude/permission`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(res.status, 401);
  });

  it("rejects /hooks/* with wrong secret", async () => {
    const res = await fetch(`${baseUrl}/hooks/claude/permission`, {
      method: "POST",
      headers: { Authorization: "Bearer wrong-secret" },
      body: "{}",
    });
    assert.equal(res.status, 401);
  });

  it("rejects /hooks/* with wrong prefix", async () => {
    const res = await fetch(`${baseUrl}/hooks/claude/permission`, {
      method: "POST",
      headers: { Authorization: config.sharedSecret },
      body: "{}",
    });
    assert.equal(res.status, 401);
  });

  it("rejects /hooks/* when secret has same length but differs", async () => {
    const wrong = "x".repeat(config.sharedSecret.length);
    const res = await fetch(`${baseUrl}/hooks/claude/permission`, {
      method: "POST",
      headers: { Authorization: `Bearer ${wrong}` },
      body: "{}",
    });
    assert.equal(res.status, 401);
  });
});

describe("invalid routes / payloads", () => {
  it("returns 404 for unknown paths", async () => {
    const res = await fetch(`${baseUrl}/does/not/exist`);
    assert.equal(res.status, 404);
  });

  it("returns 400 on missing required fields", async () => {
    const res = await fetch(`${baseUrl}/hooks/claude/permission`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "s1" }), // missing tool_name
    });
    assert.equal(res.status, 400);
  });
});

describe("POST /hooks/claude/permission", () => {
  it("holds the response open and returns allow when resolved via Telegram", async () => {
    const pending = fetch(`${baseUrl}/hooks/claude/permission`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "s1",
        cwd: "/tmp/proj",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      }),
    });

    // Wait for the server to register the pending approval + send the Telegram message
    await waitFor(() => getPendingApprovals().length === 1);
    await waitFor(() => calls.sendMessage.length === 1);

    const [approval] = getPendingApprovals();
    resolvePendingApproval(approval.id, { approved: true });

    const res = await pending;
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      hookSpecificOutput: { decision: { behavior: string } };
    };
    assert.equal(body.hookSpecificOutput.decision.behavior, "allow");
  });

  it("returns deny with reason=timeout when no response in time", async () => {
    // env-setup set CLAUDE_TIMEOUT_SECONDS=1, so this resolves in ~1s
    const res = await fetch(`${baseUrl}/hooks/claude/permission`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "s-timeout",
        cwd: "/tmp",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "sleep" },
      }),
    });
    const body = (await res.json()) as {
      hookSpecificOutput: { decision: { behavior: string; reason?: string } };
    };
    assert.equal(body.hookSpecificOutput.decision.behavior, "deny");
    assert.equal(body.hookSpecificOutput.decision.reason, "timeout");
    // Telegram message should have been edited to the timeout state
    await waitFor(() =>
      calls.editMessageText.some((c) => /No Telegram response/.test(c.text)),
    );
  });

  it("drops the pending approval when the client disconnects", async () => {
    const controller = new AbortController();
    const pending = fetch(`${baseUrl}/hooks/claude/permission`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "s-abort",
        cwd: "/tmp",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "x" },
      }),
      signal: controller.signal,
    }).catch(() => undefined);

    await waitFor(() => getPendingApprovals().length === 1);
    controller.abort();
    await pending;
    await waitFor(() => getPendingApprovals().length === 0);
    // "Resolved in terminal" edit should fire
    await waitFor(() =>
      calls.editMessageText.some((c) => /Resolved in terminal/.test(c.text)),
    );
  });
});

describe("POST /hooks/claude/posttool", () => {
  it("correlates a still-pending approval and resolves it as approved", async () => {
    const pending = fetch(`${baseUrl}/hooks/claude/permission`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "s-race",
        cwd: "/tmp",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "make" },
      }),
    });

    await waitFor(() => getPendingApprovals().length === 1);

    // PostToolUse arrives while PermissionRequest is still open
    const postRes = await fetch(`${baseUrl}/hooks/claude/posttool`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "s-race",
        cwd: "/tmp",
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "make" },
      }),
    });
    assert.equal(postRes.status, 200);

    const res = await pending;
    const body = (await res.json()) as {
      hookSpecificOutput: { decision: { behavior: string } };
    };
    assert.equal(body.hookSpecificOutput.decision.behavior, "allow");
    await waitFor(() =>
      calls.editMessageText.some((c) => /Approved in terminal/.test(c.text)),
    );
  });

  it("correlates a stashed recent approval and updates its message", async () => {
    // Create + resolve an approval with a Telegram message attached
    const pending = fetch(`${baseUrl}/hooks/claude/permission`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "s-recent",
        cwd: "/tmp",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "make test" },
      }),
    });
    await waitFor(() => getPendingApprovals().length === 1);
    const [a] = getPendingApprovals();
    resolvePendingApproval(a.id, { approved: true });
    await pending;

    // Now PostToolUse arrives. Pending is empty; correlation falls through
    // to the recent-approvals map.
    const postRes = await fetch(`${baseUrl}/hooks/claude/posttool`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "s-recent",
        cwd: "/tmp",
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "make test" },
      }),
    });
    assert.equal(postRes.status, 200);
    await waitFor(() =>
      calls.editMessageText.some((c) => /Approved in terminal/.test(c.text)),
    );
  });

  it("no-ops when there's nothing to correlate", async () => {
    const postRes = await fetch(`${baseUrl}/hooks/claude/posttool`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "s-orphan",
        cwd: "/tmp",
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "whoami" },
      }),
    });
    assert.equal(postRes.status, 200);
    assert.equal(calls.editMessageText.length, 0);
  });
});

describe("POST /hooks/claude/userprompt", () => {
  it("stores the prompt as the session's currentTask", async () => {
    const res = await fetch(`${baseUrl}/hooks/claude/userprompt`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "s-prompt",
        cwd: "/tmp/proj",
        hook_event_name: "UserPromptSubmit",
        prompt: "refactor auth middleware",
      }),
    });
    assert.equal(res.status, 200);
    const [s] = getActiveSessions(60);
    assert.equal(s?.id, "s-prompt");
    assert.equal(s?.currentTask, "refactor auth middleware");
  });

  it("returns 400 on invalid payload", async () => {
    const res = await fetch(`${baseUrl}/hooks/claude/userprompt`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "s1" }),
    });
    assert.equal(res.status, 400);
  });

  it("surfaces the captured task on subsequent PermissionRequest messages", async () => {
    await fetch(`${baseUrl}/hooks/claude/userprompt`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "s-chained",
        cwd: "/tmp",
        hook_event_name: "UserPromptSubmit",
        prompt: "write the test harness",
      }),
    });

    const pending = fetch(`${baseUrl}/hooks/claude/permission`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "s-chained",
        cwd: "/tmp",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      }),
    });
    await waitFor(() => getPendingApprovals().length === 1);
    await waitFor(() => calls.sendMessage.length === 1);
    assert.match(
      calls.sendMessage[0]!.text,
      /Task: write the test harness/,
    );
    const [a] = getPendingApprovals();
    resolvePendingApproval(a!.id, { approved: true });
    await pending;
  });
});

describe("POST /hooks/codex/userprompt", () => {
  it("captures the prompt and tracks the session as codex agent", async () => {
    const res = await fetch(`${baseUrl}/hooks/codex/userprompt`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "codex-prompt",
        cwd: "/tmp/proj",
        hook_event_name: "UserPromptSubmit",
        prompt: "wire up the codex side",
      }),
    });
    assert.equal(res.status, 200);
    const sessions = getActiveSessions(60);
    const tracked = sessions.find((s) => s.id === "codex-prompt");
    assert.equal(tracked?.agent, "codex");
    assert.equal(tracked?.currentTask, "wire up the codex side");
  });

  it("surfaces the captured task on subsequent Codex PreToolUse messages", async () => {
    await fetch(`${baseUrl}/hooks/codex/userprompt`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "codex-chained",
        cwd: "/tmp",
        hook_event_name: "UserPromptSubmit",
        prompt: "codex task here",
      }),
    });

    const pending = fetch(`${baseUrl}/hooks/codex/pretool`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "codex-chained",
        cwd: "/tmp",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      }),
    });
    await waitFor(() => getPendingApprovals().length === 1);
    await waitFor(() => calls.sendMessage.length === 1);
    assert.match(calls.sendMessage[0]!.text, /Task: codex task here/);
    const [a] = getPendingApprovals();
    resolvePendingApproval(a!.id, { approved: true });
    await pending;
  });
});

describe("POST /hooks/claude/stopfailure", () => {
  it("sends a Telegram notification carrying error_type and error_message", async () => {
    const res = await fetch(`${baseUrl}/hooks/claude/stopfailure`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "s-stopfail",
        cwd: "/tmp/proj",
        hook_event_name: "StopFailure",
        error_type: "rate_limit",
        error_message: "Rate limit exceeded. Please retry after 30 seconds.",
      }),
    });
    assert.equal(res.status, 200);
    await waitFor(() => calls.sendMessage.length === 1);
    const [sent] = calls.sendMessage;
    assert.match(sent!.text, /rate_limit/);
    assert.match(sent!.text, /retry after 30 seconds/);
  });

  it("returns 400 when error_type is missing", async () => {
    const res = await fetch(`${baseUrl}/hooks/claude/stopfailure`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "s-bad",
        cwd: "/tmp",
        hook_event_name: "StopFailure",
      }),
    });
    assert.equal(res.status, 400);
  });

  it("requires auth", async () => {
    const res = await fetch(`${baseUrl}/hooks/claude/stopfailure`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "s",
        cwd: "/tmp",
        hook_event_name: "StopFailure",
        error_type: "rate_limit",
        error_message: "x",
      }),
    });
    assert.equal(res.status, 401);
  });

  it("tracks the session so it shows up in /sessions", async () => {
    const res = await fetch(`${baseUrl}/hooks/claude/stopfailure`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "s-tracked",
        cwd: "/tmp/foo",
        hook_event_name: "StopFailure",
        error_type: "rate_limit",
        error_message: "",
      }),
    });
    assert.equal(res.status, 200);
    const active = getActiveSessions(60);
    assert.ok(active.some((s) => s.id === "s-tracked"));
  });
});

describe("shouldNotifyStop", () => {
  function makeSession(overrides: Partial<Session> = {}): Session {
    return {
      id: "s1",
      agent: "claude",
      label: "lbl",
      cwd: "/tmp",
      lastSeen: 0,
      ...overrides,
    };
  }

  it("returns true regardless of timing when minSeconds=0", () => {
    const s = makeSession({ taskStartedAt: 1000 });
    assert.equal(shouldNotifyStop(s, 1500, 0), true);
    assert.equal(shouldNotifyStop(makeSession(), 0, 0), true);
  });

  it("returns false when no taskStartedAt and threshold > 0", () => {
    // Without UserPromptSubmit data we can't tell turn duration — be conservative
    assert.equal(shouldNotifyStop(makeSession(), Date.now(), 30), false);
  });

  it("returns true when elapsed time meets the threshold", () => {
    const start = 0;
    const now = 30_000; // exactly 30s
    const s = makeSession({ taskStartedAt: start });
    assert.equal(shouldNotifyStop(s, now, 30), true);
  });

  it("returns false when elapsed time is below the threshold", () => {
    const start = 0;
    const now = 29_999;
    const s = makeSession({ taskStartedAt: start });
    assert.equal(shouldNotifyStop(s, now, 30), false);
  });
});

describe("POST /hooks/claude/stop", () => {
  it("notifies on Stop with last_assistant_message and current task", async () => {
    // Establish a task first so currentTask is populated
    await fetch(`${baseUrl}/hooks/claude/userprompt`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "s-stop",
        cwd: "/tmp/proj",
        hook_event_name: "UserPromptSubmit",
        prompt: "build the stop hook",
      }),
    });
    const res = await fetch(`${baseUrl}/hooks/claude/stop`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "s-stop",
        cwd: "/tmp/proj",
        hook_event_name: "Stop",
        last_assistant_message: "All wired up. Ready for review.",
      }),
    });
    assert.equal(res.status, 200);
    await waitFor(() => calls.sendMessage.length === 1);
    const [sent] = calls.sendMessage;
    assert.match(sent!.text, /Done/);
    assert.match(sent!.text, /Task: build the stop hook/);
    assert.match(sent!.text, /All wired up\. Ready for review\./);
  });

  it("returns 400 on missing session_id", async () => {
    const res = await fetch(`${baseUrl}/hooks/claude/stop`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: "/tmp",
        hook_event_name: "Stop",
      }),
    });
    assert.equal(res.status, 400);
  });

  it("requires auth", async () => {
    const res = await fetch(`${baseUrl}/hooks/claude/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "s",
        cwd: "/tmp",
        hook_event_name: "Stop",
      }),
    });
    assert.equal(res.status, 401);
  });

  it("tracks the session even when no notification is sent", async () => {
    // Even in the (unfiltered) test env we still want the upsertSession side
    // effect — Stop is a useful liveness signal regardless of notification.
    const res = await fetch(`${baseUrl}/hooks/claude/stop`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "s-track",
        cwd: "/tmp/foo",
        hook_event_name: "Stop",
      }),
    });
    assert.equal(res.status, 200);
    const active = getActiveSessions(60);
    assert.ok(active.some((s) => s.id === "s-track" && s.agent === "claude"));
  });
});

describe("POST /hooks/codex/pretool", () => {
  it("returns permissionDecision=allow when resolved via Telegram", async () => {
    const pending = fetch(`${baseUrl}/hooks/codex/pretool`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "codex-1",
        cwd: "/tmp",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      }),
    });
    await waitFor(() => getPendingApprovals().length === 1);
    const [a] = getPendingApprovals();
    resolvePendingApproval(a.id, { approved: true });
    const res = await pending;
    const body = (await res.json()) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    assert.equal(body.hookSpecificOutput.permissionDecision, "allow");
  });

  it("returns permissionDecision=deny on timeout", async () => {
    const res = await fetch(`${baseUrl}/hooks/codex/pretool`, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "codex-t",
        cwd: "/tmp",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "sleep" },
      }),
    });
    const body = (await res.json()) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    assert.equal(body.hookSpecificOutput.permissionDecision, "deny");
  });
});
