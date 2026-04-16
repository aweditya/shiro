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
 * Foreground commands we treat as "an agent is running here." Matched by
 * prefix so truncated names from tmux (e.g. `codex-aarch64-apple-darwin`
 * displayed as `codex-aarch64-a`) still count. Manual /bind covers anything
 * we miss.
 */
const AGENT_COMMAND_PREFIXES = ["claude", "codex"];

function isAgentCommand(command: string): boolean {
  return AGENT_COMMAND_PREFIXES.some((p) => command.startsWith(p));
}

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
    if (!isAgentCommand(command)) continue;
    panes.push({ target, command, cwd });
  }
  return panes;
}

/**
 * Check whether a tmux target (session, window, or pane) currently resolves.
 * Uses `list-panes -t` because `display-message -p -t` silently falls back to
 * the current pane on tmux 3.6 when the target doesn't exist (returns exit 0
 * with empty output) — making it useless as an existence probe.
 *
 * Returns false on any tmux error — callers treat "can't tell" as "gone".
 */
export async function paneExists(target: string): Promise<boolean> {
  try {
    await execFileP("tmux", ["list-panes", "-t", target]);
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
