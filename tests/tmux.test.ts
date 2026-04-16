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

  it("includes node panes (Codex runs as node)", () => {
    const stdout = "codex-sess:1.0\tnode\t/Users/a/proj";
    assert.deepEqual(parseAgentPanes(stdout), [
      { target: "codex-sess:1.0", command: "node", cwd: "/Users/a/proj" },
    ]);
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
