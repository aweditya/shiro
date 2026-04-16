import { timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Bot } from "grammy";
import { config } from "./config.js";
import {
  addPendingApproval,
  resolvePendingApproval,
  upsertSession,
} from "./state.js";
import {
  notifyResolvedLocally,
  notifyTimeout,
  sendApprovalMessage,
} from "./telegram.js";
import type {
  ApprovalDecision,
  ClaudePermissionRequestInput,
  CodexPreToolUseInput,
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

      if (req.method === "POST" && req.url === "/hooks/codex/pretool") {
        await handleCodexPreTool(req, res, bot);
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

  upsertSession("claude", body.session_id, body.cwd ?? "");

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

  upsertSession("codex", body.session_id, body.cwd ?? "");

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
      resolve: (decision) => settle(decision),
    });

    const timeoutHandle = setTimeout(() => {
      const resolved = resolvePendingApproval(approval.id, {
        approved: false,
        reason: "timeout",
      });
      if (resolved) {
        void notifyTimeout(args.bot, resolved);
      } else {
        // Already resolved elsewhere
        settle({ approved: false, reason: "timeout" });
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
