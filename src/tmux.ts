import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface TmuxPane {
  /** tmux target string: "session:window.pane" — usable directly with -t */
  target: string;
  /** Foreground process name (pane_current_command) */
  command: string;
  /** Pane's current working directory */
  cwd: string;
}

/**
 * Foreground processes we treat as "an agent is running here." Loose by design:
 * `node` matches Codex (which runs as a Node binary) but also any other Node
 * process. The cwd match in auto-bind narrows it; manual /bind covers the rest.
 */
const AGENT_COMMANDS = new Set(["claude", "codex", "node"]);

/**
 * List every tmux pane on the default server whose foreground process looks
 * like an agent. Returns [] if tmux isn't installed, no server is running, or
 * any other error — auto-discovery is best-effort and never fatal.
 */
export async function listAgentPanes(): Promise<TmuxPane[]> {
  try {
    const { stdout } = await execFileP("tmux", [
      "list-panes",
      "-a",
      "-F",
      "#{session_name}:#{window_index}.#{pane_index}\t#{pane_current_command}\t#{pane_current_path}",
    ]);
    return parseAgentPanes(stdout);
  } catch {
    return [];
  }
}

/** Pure: parse `tmux list-panes` output and filter to agent panes. */
export function parseAgentPanes(stdout: string): TmuxPane[] {
  const panes: TmuxPane[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const [target, command, cwd] = line.split("\t");
    if (!target || !command || !cwd) continue;
    if (!AGENT_COMMANDS.has(command)) continue;
    panes.push({ target, command, cwd });
  }
  return panes;
}

/**
 * Check whether a tmux target (session, window, or pane) currently resolves.
 * Returns false on any tmux error — callers treat "can't tell" as "gone".
 */
export async function paneExists(target: string): Promise<boolean> {
  try {
    await execFileP("tmux", ["display-message", "-p", "-t", target, "#{pane_id}"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Type a message into a tmux pane and submit with Enter. The message is passed
 * as a single argv element with `-l` (literal mode), so tmux does no key
 * interpretation — embedded backticks, dollar signs, etc. are safe.
 *
 * Errors are propagated so the caller can distinguish "sent" from "tmux dead".
 */
export async function sendKeys(target: string, message: string): Promise<void> {
  await execFileP("tmux", ["send-keys", "-t", target, "-l", message]);
  await execFileP("tmux", ["send-keys", "-t", target, "Enter"]);
}
