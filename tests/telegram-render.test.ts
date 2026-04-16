import "./env-setup.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cwdLabel,
  escapeHtml,
  formatAge,
  renderApprovalMessage,
  renderResolvedLocallyMessage,
  renderResolvedMessage,
  renderSessionLine,
  renderStopFailureMessage,
  renderTimeoutMessage,
  renderToolRanMessage,
  shortId,
  summarizeTool,
  truncate,
} from "../src/telegram.js";
import type { PendingApproval, Session } from "../src/types.js";

function makeApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: "aprv-1",
    agent: "claude",
    sessionId: "s1",
    toolName: "Bash",
    toolInput: { command: "ls -la" },
    cwd: "/Users/alice/projects/shiro",
    receivedAt: Date.now(),
    resolve: () => {},
    ...overrides,
  };
}

describe("escapeHtml", () => {
  it("escapes &, <, > in that order", () => {
    assert.equal(escapeHtml("a & b < c > d"), "a &amp; b &lt; c &gt; d");
  });

  it("escapes ampersand before angle brackets (no double-encoding)", () => {
    assert.equal(escapeHtml("<&>"), "&lt;&amp;&gt;");
  });
});

describe("cwdLabel", () => {
  it("returns last two path segments for deep paths", () => {
    assert.equal(cwdLabel("/Users/alice/projects/shiro"), "projects/shiro");
  });

  it("returns full cwd when path has 2 or fewer segments", () => {
    assert.equal(cwdLabel("/tmp"), "/tmp");
    assert.equal(cwdLabel("/a/b"), "/a/b");
  });
});

describe("formatAge", () => {
  it("formats seconds under a minute", () => {
    assert.equal(formatAge(5_000), "5s");
    assert.equal(formatAge(59_000), "59s");
  });

  it("formats minutes under an hour", () => {
    assert.equal(formatAge(60_000), "1m");
    assert.equal(formatAge(30 * 60_000), "30m");
  });

  it("formats hours", () => {
    assert.equal(formatAge(60 * 60_000), "1h");
    assert.equal(formatAge(5 * 60 * 60_000), "5h");
  });
});

describe("summarizeTool", () => {
  it("prefers command field", () => {
    assert.equal(summarizeTool("Bash", { command: "ls" }), "ls");
  });

  it("prefers file_path, appending content when present", () => {
    const out = summarizeTool("Write", {
      file_path: "/a/b.txt",
      content: "hello",
    });
    assert.ok(out.startsWith("/a/b.txt"));
    assert.ok(out.includes("hello"));
  });

  it("returns just the path when file_path has no content", () => {
    assert.equal(summarizeTool("Read", { file_path: "/a/b.txt" }), "/a/b.txt");
  });

  it("falls back to url", () => {
    assert.equal(
      summarizeTool("WebFetch", { url: "https://example.com" }),
      "https://example.com",
    );
  });

  it("falls back to pretty-printed JSON for unknown shapes", () => {
    const out = summarizeTool("Custom", { foo: 1, bar: "baz" });
    assert.ok(out.includes("foo"));
    assert.ok(out.includes("bar"));
  });

  it("truncates long commands and includes a marker", () => {
    const long = "x".repeat(1000);
    const out = summarizeTool("Bash", { command: long });
    assert.ok(out.length < long.length);
    assert.match(out, /truncated/);
  });
});

describe("render* functions", () => {
  it("renderApprovalMessage includes agent tag, label, tool, and summary", () => {
    const msg = renderApprovalMessage(makeApproval());
    assert.match(msg, /Claude/);
    assert.match(msg, /projects\/shiro/);
    assert.match(msg, /Bash/);
    assert.match(msg, /ls -la/);
    assert.match(msg, /Permission needed/);
  });

  it("renderResolvedMessage says APPROVED when approved=true", () => {
    const msg = renderResolvedMessage(makeApproval(), true);
    assert.match(msg, /APPROVED/);
    assert.doesNotMatch(msg, /DENIED/);
  });

  it("renderResolvedMessage says DENIED when approved=false", () => {
    const msg = renderResolvedMessage(makeApproval(), false);
    assert.match(msg, /DENIED/);
  });

  it("renderTimeoutMessage avoids misleading verdict words", () => {
    const msg = renderTimeoutMessage(makeApproval());
    assert.match(msg, /No Telegram response/);
    // Per user feedback: don't claim denied or approved when we don't know
    assert.doesNotMatch(msg, /\bDENIED\b/);
    assert.doesNotMatch(msg, /\bAPPROVED\b/);
  });

  it("renderResolvedLocallyMessage says 'Resolved in terminal'", () => {
    const msg = renderResolvedLocallyMessage(makeApproval());
    assert.match(msg, /Resolved in terminal/);
  });

  it("renderToolRanMessage says 'Approved in terminal'", () => {
    const msg = renderToolRanMessage(makeApproval(), null);
    assert.match(msg, /Approved in terminal/);
  });

  it("renderToolRanMessage flags interrupted tool responses", () => {
    const msg = renderToolRanMessage(makeApproval(), { interrupted: true });
    assert.match(msg, /interrupted/i);
  });

  it("renderToolRanMessage flags stderr-only outcomes", () => {
    const msg = renderToolRanMessage(makeApproval(), {
      stdout: "",
      stderr: "bad",
    });
    assert.match(msg, /stderr/);
  });

  it("HTML-escapes user-supplied cwd and tool input", () => {
    const approval = makeApproval({
      cwd: "/a/<danger>",
      toolInput: { command: "echo <script>alert(1)</script>" },
    });
    const msg = renderApprovalMessage(approval);
    assert.doesNotMatch(msg, /<script>/);
    assert.match(msg, /&lt;script&gt;/);
  });

  it("uses Codex tag for codex agent", () => {
    const msg = renderApprovalMessage(makeApproval({ agent: "codex" }));
    assert.match(msg, /Codex/);
  });

  it("renderApprovalMessage includes the Task line when approval has one", () => {
    const msg = renderApprovalMessage(
      makeApproval({ task: "add PostToolUse correlation" }),
    );
    assert.match(msg, /Task: add PostToolUse correlation/);
  });

  it("renderApprovalMessage omits the Task line when absent", () => {
    const msg = renderApprovalMessage(makeApproval({ task: undefined }));
    assert.doesNotMatch(msg, /Task:/);
  });

  it("renderApprovalMessage HTML-escapes the task", () => {
    const msg = renderApprovalMessage(
      makeApproval({ task: "<img src=x>" }),
    );
    assert.doesNotMatch(msg, /<img/);
    assert.match(msg, /&lt;img/);
  });
});

describe("renderStopFailureMessage", () => {
  function makeSession(overrides: Partial<Session> = {}): Session {
    return {
      id: "sess123",
      agent: "claude",
      label: "shiro",
      cwd: "/Users/alice/projects/shiro",
      lastSeen: Date.now(),
      ...overrides,
    };
  }

  it("includes error_type, agent tag, and cwd label", () => {
    const msg = renderStopFailureMessage(
      makeSession(),
      "rate_limit",
      "Rate limit exceeded. Please retry after 30 seconds.",
    );
    assert.match(msg, /Stopped: rate_limit/);
    assert.match(msg, /Claude/);
    assert.match(msg, /projects\/shiro/);
    assert.match(msg, /retry after 30 seconds/);
  });

  it("omits the error message block when empty", () => {
    const msg = renderStopFailureMessage(makeSession(), "unknown", "");
    assert.match(msg, /Stopped: unknown/);
    assert.doesNotMatch(msg, /<pre>/);
  });

  it("includes Task line when session has currentTask", () => {
    const msg = renderStopFailureMessage(
      makeSession({ currentTask: "refactor auth middleware" }),
      "rate_limit",
      "limit hit",
    );
    assert.match(msg, /Task: refactor auth middleware/);
  });

  it("HTML-escapes error_type and error_message", () => {
    const msg = renderStopFailureMessage(
      makeSession(),
      "<weird>",
      "<script>alert(1)</script>",
    );
    assert.doesNotMatch(msg, /<script>/);
    assert.match(msg, /&lt;script&gt;/);
    assert.match(msg, /&lt;weird&gt;/);
  });
});

describe("shortId", () => {
  it("returns the first 6 chars of the session id", () => {
    assert.equal(shortId("abcdef123456"), "abcdef");
  });
});

describe("truncate", () => {
  it("returns the input unchanged when within limit", () => {
    assert.equal(truncate("hi", 10), "hi");
  });

  it("truncates and annotates when longer than limit", () => {
    const out = truncate("x".repeat(20), 5);
    assert.ok(out.startsWith("xxxxx"));
    assert.match(out, /truncated 15 chars/);
  });
});

describe("renderSessionLine", () => {
  function makeSession(overrides: Partial<Session> = {}): Session {
    return {
      id: "abc123def456",
      agent: "claude",
      label: "shiro",
      cwd: "/Users/alice/projects/shiro",
      lastSeen: Date.now(),
      ...overrides,
    };
  }

  it("includes short id, label, cwd, and age", () => {
    const line = renderSessionLine(makeSession());
    assert.match(line, /abc123/);
    assert.match(line, /shiro/);
    assert.match(line, /\/Users\/alice\/projects\/shiro/);
    assert.match(line, /ago/);
  });

  it("shows Task line only when currentTask is set", () => {
    const withTask = renderSessionLine(
      makeSession({ currentTask: "writing tests" }),
    );
    assert.match(withTask, /Task: writing tests/);
    const without = renderSessionLine(makeSession());
    assert.doesNotMatch(without, /Task:/);
  });
});
