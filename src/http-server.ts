import { timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Bot } from "grammy";
import { config } from "./config.js";
import {
  addPendingApproval,
  consumePhonePromptPending,
  findPendingByCorrelation,
  getBinding,
  hasAttemptedAutoBind,
  markAutoBindAttempted,
  popRecentApproval,
  resolvePendingApproval,
  setBinding,
  setSessionTask,
  upsertSession,
} from "./state.js";
import { listAgentPanes, type TmuxPane } from "./tmux.js";
import {
  notifyResolvedLocally,
  notifyStopFailure,
  notifyStopped,
  notifyTimeout,
  notifyToolRan,
  sendApprovalMessage,
} from "./telegram.js";
import type {
  AgentKind,
  ApprovalDecision,
  ClaudePermissionRequestInput,
  ClaudePostToolUseInput,
  ClaudeStopFailureInput,
  ClaudeStopInput,
  CodexPreToolUseInput,
  Session,
  UserPromptSubmitInput,
} from "./types.js";

export function createHttpServer(bot: Bot): http.Server {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        // Unauthenticated — safe to ping for liveness checks
        writeJson(res, 200, { ok: true });
        return;
      }

      // Every hook endpoint requires the shared secret. Reject before any
      // body parsing so we never accept untrusted payloads.
      if (req.url?.startsWith("/hooks/")) {
        if (!isAuthorized(req)) {
          writeJson(res, 401, { error: "unauthorized" });
          return;
        }
      }

      if (req.method === "POST" && req.url === "/hooks/claude/permission") {
        await handleClaudePermission(req, res, bot);
        return;
      }

      if (req.method === "POST" && req.url === "/hooks/claude/posttool") {
        await handleClaudePostTool(req, res, bot);
        return;
      }

      if (req.method === "POST" && req.url === "/hooks/claude/userprompt") {
        await handleUserPrompt("claude", req, res);
        return;
      }

      if (req.method === "POST" && req.url === "/hooks/claude/stopfailure") {
        await handleClaudeStopFailure(req, res, bot);
        return;
      }

      if (req.method === "POST" && req.url === "/hooks/claude/stop") {
        await handleClaudeStop(req, res, bot);
        return;
      }

      if (req.method === "POST" && req.url === "/hooks/codex/pretool") {
        await handleCodexPreTool(req, res, bot);
        return;
      }

      if (req.method === "POST" && req.url === "/hooks/codex/userprompt") {
        await handleUserPrompt("codex", req, res);
        return;
      }

      writeJson(res, 404, { error: "not_found" });
    } catch (err) {
      console.error("HTTP handler error:", err);
      if (!res.headersSent) {
        writeJson(res, 500, { error: "internal_error" });
      }
    }
  });
}

function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return false;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const provided = header.slice(prefix.length).trim();
  const expected = config.sharedSecret;
  // Use timingSafeEqual to avoid leaking the secret length via timing.
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

async function handleClaudePermission(
  req: IncomingMessage,
  res: ServerResponse,
  bot: Bot,
): Promise<void> {
  const body = await readJson<ClaudePermissionRequestInput>(req);
  if (!body || !body.session_id || !body.tool_name) {
    writeJson(res, 400, { error: "invalid_payload" });
    return;
  }

  const session = upsertSession("claude", body.session_id, body.cwd ?? "");
  void tryAutoBind(body.session_id, body.cwd ?? "");

  const decision = await awaitDecision({
    res,
    bot,
    timeoutSeconds: config.claudeTimeoutSeconds,
    approval: {
      agent: "claude",
      sessionId: body.session_id,
      toolName: body.tool_name,
      toolInput: body.tool_input ?? {},
      cwd: body.cwd ?? "",
      task: session.currentTask,
    },
  });

  const payload = {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: decision.approved ? "allow" : "deny",
        ...(decision.reason ? { reason: decision.reason } : {}),
      },
    },
  };
  writeJson(res, 200, payload);
}

async function handleClaudePostTool(
  req: IncomingMessage,
  res: ServerResponse,
  bot: Bot,
): Promise<void> {
  const body = await readJson<ClaudePostToolUseInput>(req);
  if (!body || !body.session_id || !body.tool_name) {
    writeJson(res, 400, { error: "invalid_payload" });
    return;
  }

  upsertSession("claude", body.session_id, body.cwd ?? "");
  void tryAutoBind(body.session_id, body.cwd ?? "");

  // PostToolUse is the ground truth: the tool ran. Correlate back to any
  // Telegram message we showed for this (session, tool, input) combo and
  // update it to reflect the actual outcome.
  const toolInput = body.tool_input ?? {};

  // Case A: the pending approval is still open (agent kept the HTTP connection
  // open despite resolving the permission locally). Resolve it now as approved
  // — the tool actually ran.
  const pending = findPendingByCorrelation(
    "claude",
    body.session_id,
    body.tool_name,
    toolInput,
  );
  if (pending) {
    const resolved = resolvePendingApproval(pending.id, {
      approved: true,
      reason: "approved_in_terminal",
    });
    if (resolved) {
      void notifyToolRan(bot, resolved, body.tool_response ?? null);
    }
  } else {
    // Case B: the approval is already resolved (timed out or closed-locally),
    // but we stashed it for correlation. Update the stale Telegram message.
    const recent = popRecentApproval(
      "claude",
      body.session_id,
      body.tool_name,
      toolInput,
    );
    if (recent) {
      void notifyToolRan(bot, recent.approval, body.tool_response ?? null);
    }
  }

  // PostToolUse hooks don't need a permission-style response; return 200 fast.
  writeJson(res, 200, { ok: true });
}

async function handleUserPrompt(
  agent: AgentKind,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJson<UserPromptSubmitInput>(req);
  if (!body || !body.session_id || typeof body.prompt !== "string") {
    writeJson(res, 400, { error: "invalid_payload" });
    return;
  }
  upsertSession(agent, body.session_id, body.cwd ?? "");
  if (agent === "claude") {
    void tryAutoBind(body.session_id, body.cwd ?? "");
  }
  setSessionTask(body.session_id, body.prompt);
  writeJson(res, 200, { ok: true });
}

async function handleClaudeStopFailure(
  req: IncomingMessage,
  res: ServerResponse,
  bot: Bot,
): Promise<void> {
  const body = await readJson<ClaudeStopFailureInput>(req);
  if (!body || !body.session_id || !body.error_type) {
    writeJson(res, 400, { error: "invalid_payload" });
    return;
  }
  const session = upsertSession("claude", body.session_id, body.cwd ?? "");
  void tryAutoBind(body.session_id, body.cwd ?? "");
  void notifyStopFailure(
    bot,
    session,
    body.error_type,
    body.error_message ?? "",
  );
  writeJson(res, 200, { ok: true });
}

async function handleClaudeStop(
  req: IncomingMessage,
  res: ServerResponse,
  bot: Bot,
): Promise<void> {
  const body = await readJson<ClaudeStopInput>(req);
  if (!body || !body.session_id) {
    writeJson(res, 400, { error: "invalid_payload" });
    return;
  }
  const session = upsertSession("claude", body.session_id, body.cwd ?? "");
  void tryAutoBind(body.session_id, body.cwd ?? "");
  // Always 200 — Stop hooks don't gate Claude on our response, so respond
  // fast and decide about Telegram separately.
  writeJson(res, 200, { ok: true });
  // A pending /say from the phone bypasses the duration filter so even sub-
  // 30s replies make it back. The notification also gets a "Reply to /say:"
  // prefix so it visually stands out from spontaneous turn completions.
  const phoneDriven = consumePhonePromptPending(body.session_id);
  if (
    phoneDriven ||
    shouldNotifyStop(session, Date.now(), config.stopNotifyMinSeconds)
  ) {
    void notifyStopped(
      bot,
      session,
      body.last_assistant_message ?? "",
      phoneDriven,
    );
  }
}

/**
 * Best-effort: on the first hook fire from a previously unseen Claude session,
 * try to find a tmux pane in the same cwd running an agent. Only bind if
 * exactly one match — multiple matches need manual /bind to disambiguate.
 *
 * Cached by session id so we don't reshell on every hook. Auto-discovery is
 * Claude-only for v1; Codex injection works the same way but its response
 * routing isn't built yet (no Stop hook equivalent).
 *
 * `listPanes` is injectable so tests can drive each branch without shelling
 * out to a real tmux server.
 */
export async function tryAutoBind(
  sessionId: string,
  cwd: string,
  listPanes: () => Promise<TmuxPane[]> = listAgentPanes,
): Promise<void> {
  if (!cwd) return;
  if (hasAttemptedAutoBind(sessionId)) return;
  if (getBinding(sessionId)) return;
  markAutoBindAttempted(sessionId);
  let panes: TmuxPane[];
  try {
    panes = await listPanes();
  } catch {
    // Best-effort: if introspection fails (tmux gone, exec error, anything),
    // skip binding silently. Caller fires us with `void`, so we must never
    // surface as an unhandled rejection.
    return;
  }
  const matches = panes.filter((p) => p.cwd === cwd);
  if (matches.length !== 1) return;
  const [pane] = matches as [(typeof matches)[number]];
  setBinding(sessionId, pane.target, "auto");
}

/**
 * Stop fires on every turn completion, so without filtering you'd get pinged
 * during normal interactive chat. Only notify when we have evidence the turn
 * was long enough to suggest the user walked away. Setting `minSeconds=0`
 * disables the filter (notify on every Stop).
 */
export function shouldNotifyStop(
  session: Session,
  now: number,
  minSeconds: number,
): boolean {
  if (minSeconds <= 0) return true;
  if (session.taskStartedAt === undefined) return false;
  const elapsed = (now - session.taskStartedAt) / 1000;
  return elapsed >= minSeconds;
}

async function handleCodexPreTool(
  req: IncomingMessage,
  res: ServerResponse,
  bot: Bot,
): Promise<void> {
  const body = await readJson<CodexPreToolUseInput>(req);
  if (!body || !body.session_id || !body.tool_name) {
    writeJson(res, 400, { error: "invalid_payload" });
    return;
  }

  const session = upsertSession("codex", body.session_id, body.cwd ?? "");

  const decision = await awaitDecision({
    res,
    bot,
    timeoutSeconds: config.codexTimeoutSeconds,
    approval: {
      agent: "codex",
      sessionId: body.session_id,
      toolName: body.tool_name,
      toolInput: body.tool_input ?? {},
      cwd: body.cwd ?? "",
      task: session.currentTask,
    },
  });

  const payload = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision.approved ? "allow" : "deny",
      ...(decision.reason
        ? { permissionDecisionReason: decision.reason }
        : {}),
    },
  };
  writeJson(res, 200, payload);
}

interface AwaitDecisionArgs {
  res: ServerResponse;
  bot: Bot;
  timeoutSeconds: number;
  approval: {
    agent: "claude" | "codex";
    sessionId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    cwd: string;
    task?: string;
  };
}

function awaitDecision(args: AwaitDecisionArgs): Promise<ApprovalDecision> {
  return new Promise<ApprovalDecision>((resolve) => {
    let settled = false;
    const settle = (decision: ApprovalDecision) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      args.res.off("close", onClose);
      resolve(decision);
    };

    const approval = addPendingApproval({
      agent: args.approval.agent,
      sessionId: args.approval.sessionId,
      toolName: args.approval.toolName,
      toolInput: args.approval.toolInput,
      cwd: args.approval.cwd,
      task: args.approval.task,
      resolve: (decision) => settle(decision),
    });

    const timeoutHandle = setTimeout(() => {
      const resolved = resolvePendingApproval(approval.id, {
        approved: false,
        reason: "timeout",
      });
      if (resolved) {
        void notifyTimeout(args.bot, resolved);
      }
    }, args.timeoutSeconds * 1000);

    const onClose = () => {
      // Client disconnected before we responded — the agent resolved this
      // locally (approved/denied in terminal, or session was killed). Drop
      // the pending approval and strip the Telegram buttons so we don't
      // show a stale action.
      const resolved = resolvePendingApproval(approval.id, {
        approved: false,
        reason: "resolved_locally",
      });
      if (resolved) {
        void notifyResolvedLocally(args.bot, resolved);
      }
    };
    args.res.on("close", onClose);

    // Fire-and-forget the Telegram notification
    void sendApprovalMessage(args.bot, approval).catch((err) => {
      console.error("Failed to send Telegram approval message:", err);
    });
  });
}

function readJson<T>(req: IncomingMessage): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw) {
          resolve(null);
          return;
        }
        resolve(JSON.parse(raw) as T);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}
