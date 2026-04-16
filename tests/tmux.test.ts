import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAgentPanes } from "../src/tmux.js";

describe("parseAgentPanes", () => {
  it("returns the panes whose foreground command is a known agent", () => {
    const stdout = [
      "main:0.0\tclaude\t/Users/a/proj-a",
      "work:0.0\tcodex\t/Users/a/proj-b",
      "shell:0.0\tzsh\t/Users/a",
    ].join("\n");
    const panes = parseAgentPanes(stdout);
    assert.deepEqual(panes, [
      { target: "main:0.0", command: "claude", cwd: "/Users/a/proj-a" },
      { target: "work:0.0", command: "codex", cwd: "/Users/a/proj-b" },
    ]);
  });

  it("matches by prefix so truncated binary names still count", () => {
    // tmux truncates pane_current_command — on macOS arm64 the Codex binary
    // shows up as `codex-aarch64-a` (full name: codex-aarch64-apple-darwin).
    const stdout = [
      "0:0.0\tcodex-aarch64-a\t/Users/a/proj-x",
      "1:0.0\tclaude-1.2.3\t/Users/a/proj-y",
    ].join("\n");
    assert.deepEqual(parseAgentPanes(stdout), [
      { target: "0:0.0", command: "codex-aarch64-a", cwd: "/Users/a/proj-x" },
      { target: "1:0.0", command: "claude-1.2.3", cwd: "/Users/a/proj-y" },
    ]);
  });

  it("does NOT pick up unrelated commands like node or zsh", () => {
    // The previous design matched bare `node` (assumed Codex). That was wrong:
    // on macOS arm64 Codex is a native binary, and `node` matched any unrelated
    // Node process — which would auto-bind to the wrong pane.
    const stdout = [
      "shell:0.0\tnode\t/Users/a/some-node-project",
      "shell:0.1\tzsh\t/Users/a",
    ].join("\n");
    assert.deepEqual(parseAgentPanes(stdout), []);
  });

  it("skips malformed and blank lines without throwing", () => {
    const stdout = ["", "garbage", "main:0.0\tclaude\t/a", ""].join("\n");
    assert.deepEqual(parseAgentPanes(stdout), [
      { target: "main:0.0", command: "claude", cwd: "/a" },
    ]);
  });

  it("returns an empty array for empty input", () => {
    assert.deepEqual(parseAgentPanes(""), []);
  });
});
