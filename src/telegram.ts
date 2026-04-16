import { Bot, InlineKeyboard } from "grammy";
import { config } from "./config.js";
import {
  attachTelegramMessage,
  clearBinding,
  findSessionByPrefix,
  getActiveSessions,
  getAllBindings,
  getPendingApproval,
  getPendingApprovals,
  getSession,
  renameSession,
  resolvePendingApproval,
  setBinding,
} from "./state.js";
import { paneExists } from "./tmux.js";
import type { PendingApproval, Session } from "./types.js";

export function createBot(): Bot {
  const bot = new Bot(config.botToken);

  // Auth middleware — ignore anything not from the owner's chat.
  bot.use(async (ctx, next) => {
    if (ctx.chat?.id !== config.chatId && ctx.from?.id !== config.chatId) {
      return;
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    await ctx.reply(
      [
        "Agent control plane online.",
        "",
        "Commands:",
        "/status — active sessions + pending approvals",
        "/sessions — list tracked sessions",
        "/pending — re-show unresolved approval requests",
        "/approveall — approve everything pending",
        "/denyall — deny everything pending",
        "/rename <short_id> <label> — rename a session",
        "/bind <short_id> <tmux_target> — bind a session to a tmux pane",
        "/unbind <short_id> — clear a session's tmux binding",
        "/bindings — list current tmux bindings",
      ].join("\n"),
    );
  });

  bot.command("status", async (ctx) => {
    const sessions = getActiveSessions(config.sessionStaleSeconds);
    const pending = getPendingApprovals();
    const lines: string[] = [];
    lines.push(
      `Sessions: ${sessions.length} active · Pending approvals: ${pending.length}`,
    );
    if (sessions.length > 0) {
      lines.push("");
      lines.push("Active sessions:");
      for (const s of sessions) {
        const ago = formatAge(Date.now() - s.lastSeen);
        const task = s.currentTask
          ? ` — ${truncate(s.currentTask, 60)}`
          : "";
        lines.push(
          `• [${agentTag(s.agent)}] ${shortId(s.id)} ${s.label} (${ago} ago)${task}`,
        );
      }
    }
    if (pending.length > 0) {
      lines.push("");
      lines.push(`Use /pending to see approval requests.`);
    }
    await ctx.reply(lines.join("\n"));
  });

  bot.command("sessions", async (ctx) => {
    const sessions = getActiveSessions(config.sessionStaleSeconds);
    if (sessions.length === 0) {
      await ctx.reply("No active sessions.");
      return;
    }
    const lines = sessions.map((s) => renderSessionLine(s));
    await ctx.reply(lines.join("\n\n"));
  });

  bot.command("rename", async (ctx) => {
    const args = ctx.match?.trim() ?? "";
    const [id, ...rest] = args.split(/\s+/);
    const label = rest.join(" ").trim();
    if (!id || !label) {
      await ctx.reply("Usage: /rename <short_id> <new_label>");
      return;
    }
    const result = renameSession(id, label);
    if (!result.ok) {
      await ctx.reply(
        result.reason === "not_found"
          ? `No session matching ${id}.`
          : `Short id ${id} matches multiple sessions — use more characters.`,
      );
      return;
    }
    await ctx.reply(`Renamed ${shortId(result.session.id)} to ${result.session.label}.`);
  });

  bot.command("bind", async (ctx) => {
    const args = ctx.match?.trim() ?? "";
    const [id, ...rest] = args.split(/\s+/);
    const target = rest.join(" ").trim();
    if (!id || !target) {
      await ctx.reply("Usage: /bind <short_id> <tmux_target>");
      return;
    }
    const found = findSessionByPrefix(id);
    if (!found.ok) {
      await ctx.reply(
        found.reason === "not_found"
          ? `No session matching ${id}.`
          : `Short id ${id} matches multiple sessions — use more characters.`,
      );
      return;
    }
    // Verify the tmux target actually resolves before we record the binding.
    // Recording a stale target would silently break /say later.
    const exists = await paneExists(target);
    if (!exists) {
      await ctx.reply(
        `tmux target ${target} not found. Check \`tmux list-panes -a\`.`,
      );
      return;
    }
    setBinding(found.session.id, target, "manual");
    await ctx.reply(
      `Bound ${shortId(found.session.id)} (${found.session.label}) → ${target}.`,
    );
  });

  bot.command("unbind", async (ctx) => {
    const id = (ctx.match?.trim() ?? "").split(/\s+/)[0] ?? "";
    if (!id) {
      await ctx.reply("Usage: /unbind <short_id>");
      return;
    }
    const found = findSessionByPrefix(id);
    if (!found.ok) {
      await ctx.reply(
        found.reason === "not_found"
          ? `No session matching ${id}.`
          : `Short id ${id} matches multiple sessions — use more characters.`,
      );
      return;
    }
    const removed = clearBinding(found.session.id);
    await ctx.reply(
      removed
        ? `Cleared binding for ${shortId(found.session.id)} (${found.session.label}).`
        : `${shortId(found.session.id)} had no binding.`,
    );
  });

  bot.command("bindings", async (ctx) => {
    const all = getAllBindings();
    if (all.length === 0) {
      await ctx.reply("No tmux bindings.");
      return;
    }
    const lines = all.map((b) => renderBindingLine(b.sessionId, b.binding));
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("pending", async (ctx) => {
    const pending = getPendingApprovals();
    if (pending.length === 0) {
      await ctx.reply("No pending approvals.");
      return;
    }
    for (const approval of pending) {
      await sendApprovalMessage(bot, approval);
    }
  });

  bot.command("approveall", async (ctx) => {
    const pending = getPendingApprovals();
    let count = 0;
    for (const approval of pending) {
      const resolved = resolvePendingApproval(approval.id, { approved: true });
      if (resolved) {
        count++;
        await editResolvedMessage(bot, resolved, true);
      }
    }
    await ctx.reply(`Approved ${count} pending request(s).`);
  });

  bot.command("denyall", async (ctx) => {
    const pending = getPendingApprovals();
    let count = 0;
    for (const approval of pending) {
      const resolved = resolvePendingApproval(approval.id, { approved: false });
      if (resolved) {
        count++;
        await editResolvedMessage(bot, resolved, false);
      }
    }
    await ctx.reply(`Denied ${count} pending request(s).`);
  });

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const [action, approvalId] = data.split(":");
    if (!action || !approvalId || (action !== "approve" && action !== "deny")) {
      await ctx.answerCallbackQuery({ text: "Unknown action" });
      return;
    }
    const approval = getPendingApproval(approvalId);
    if (!approval) {
      await ctx.answerCallbackQuery({ text: "Already resolved or expired" });
      // Try to strip the buttons off the stale message
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      } catch {
        // ignore — message may be too old to edit
      }
      return;
    }
    const approved = action === "approve";
    resolvePendingApproval(approvalId, { approved });
    await ctx.answerCallbackQuery({ text: approved ? "Approved" : "Denied" });
    try {
      await ctx.editMessageText(renderResolvedMessage(approval, approved), {
        parse_mode: "HTML",
      });
    } catch {
      // ignore edit errors
    }
  });

  bot.catch((err) => {
    console.error("Telegram bot error:", err);
  });

  return bot;
}

export async function sendApprovalMessage(
  bot: Bot,
  approval: PendingApproval,
): Promise<void> {
  const keyboard = new InlineKeyboard()
    .text("Approve", `approve:${approval.id}`)
    .text("Deny", `deny:${approval.id}`);

  const message = await bot.api.sendMessage(
    config.chatId,
    renderApprovalMessage(approval),
    {
      parse_mode: "HTML",
      reply_markup: keyboard,
    },
  );
  attachTelegramMessage(approval.id, message.chat.id, message.message_id);
}

export async function notifyTimeout(
  bot: Bot,
  approval: PendingApproval,
): Promise<void> {
  if (!approval.telegramChatId || !approval.telegramMessageId) return;
  try {
    await bot.api.editMessageText(
      approval.telegramChatId,
      approval.telegramMessageId,
      renderTimeoutMessage(approval),
      { parse_mode: "HTML" },
    );
  } catch (err) {
    console.error("Failed to edit message on timeout:", err);
  }
}

export async function notifyResolvedLocally(
  bot: Bot,
  approval: PendingApproval,
): Promise<void> {
  if (!approval.telegramChatId || !approval.telegramMessageId) return;
  try {
    await bot.api.editMessageText(
      approval.telegramChatId,
      approval.telegramMessageId,
      renderResolvedLocallyMessage(approval),
      { parse_mode: "HTML" },
    );
  } catch (err) {
    // Message may be too old to edit, or Telegram may not have sent it yet.
    // Failure here is not fatal — the approval is already resolved.
  }
}

export async function notifyStopFailure(
  bot: Bot,
  session: Session,
  errorType: string,
  errorMessage: string,
): Promise<void> {
  try {
    await bot.api.sendMessage(
      config.chatId,
      renderStopFailureMessage(session, errorType, errorMessage),
      { parse_mode: "HTML" },
    );
  } catch (err) {
    console.error("Failed to send stop failure notification:", err);
  }
}

export async function notifyStopped(
  bot: Bot,
  session: Session,
  lastAssistantMessage: string,
): Promise<void> {
  try {
    await bot.api.sendMessage(
      config.chatId,
      renderStoppedMessage(session, lastAssistantMessage),
      { parse_mode: "HTML" },
    );
  } catch (err) {
    console.error("Failed to send stop notification:", err);
  }
}

export async function notifyToolRan(
  bot: Bot,
  approval: PendingApproval,
  toolResponse: Record<string, unknown> | null,
): Promise<void> {
  if (!approval.telegramChatId || !approval.telegramMessageId) return;
  try {
    await bot.api.editMessageText(
      approval.telegramChatId,
      approval.telegramMessageId,
      renderToolRanMessage(approval, toolResponse),
      { parse_mode: "HTML" },
    );
  } catch (err) {
    // Non-fatal: message may be too old or already edited.
  }
}

async function editResolvedMessage(
  bot: Bot,
  approval: PendingApproval,
  approved: boolean,
): Promise<void> {
  if (!approval.telegramChatId || !approval.telegramMessageId) return;
  try {
    await bot.api.editMessageText(
      approval.telegramChatId,
      approval.telegramMessageId,
      renderResolvedMessage(approval, approved),
      { parse_mode: "HTML" },
    );
  } catch {
    // ignore
  }
}

export function renderApprovalMessage(approval: PendingApproval): string {
  const label = cwdLabel(approval.cwd);
  const toolSummary = summarizeTool(approval.toolName, approval.toolInput);
  const lines = [
    `<b>[${agentTag(approval.agent)}]</b> <code>${escapeHtml(label)}</code>`,
  ];
  if (approval.task) {
    lines.push(`<i>Task: ${escapeHtml(truncate(approval.task, 200))}</i>`);
  }
  lines.push(
    `<i>Permission needed: ${escapeHtml(approval.toolName)}</i>`,
    "",
    `<pre>${escapeHtml(toolSummary)}</pre>`,
  );
  return lines.join("\n");
}

export function renderResolvedMessage(
  approval: PendingApproval,
  approved: boolean,
): string {
  const header = approved ? "APPROVED" : "DENIED";
  const label = cwdLabel(approval.cwd);
  const toolSummary = summarizeTool(approval.toolName, approval.toolInput);
  return [
    `<b>${header}</b> · [${agentTag(approval.agent)}] <code>${escapeHtml(label)}</code>`,
    `<i>${escapeHtml(approval.toolName)}</i>`,
    "",
    `<pre>${escapeHtml(toolSummary)}</pre>`,
  ].join("\n");
}

export function renderTimeoutMessage(approval: PendingApproval): string {
  const label = cwdLabel(approval.cwd);
  const toolSummary = summarizeTool(approval.toolName, approval.toolInput);
  // Timeout could mean: user didn't respond anywhere, OR user responded
  // locally in the terminal but the agent kept the HTTP connection open.
  // We can't tell the difference — so don't claim a verdict here.
  return [
    `<b>No Telegram response</b> · [${agentTag(approval.agent)}] <code>${escapeHtml(label)}</code>`,
    `<i>${escapeHtml(approval.toolName)}</i>`,
    `<i>Check terminal for the actual outcome.</i>`,
    "",
    `<pre>${escapeHtml(toolSummary)}</pre>`,
  ].join("\n");
}

export function renderResolvedLocallyMessage(approval: PendingApproval): string {
  const label = cwdLabel(approval.cwd);
  const toolSummary = summarizeTool(approval.toolName, approval.toolInput);
  return [
    `<b>Resolved in terminal</b> · [${agentTag(approval.agent)}] <code>${escapeHtml(label)}</code>`,
    `<i>${escapeHtml(approval.toolName)}</i>`,
    "",
    `<pre>${escapeHtml(toolSummary)}</pre>`,
  ].join("\n");
}

export function renderStopFailureMessage(
  session: Session,
  errorType: string,
  errorMessage: string,
): string {
  const label = cwdLabel(session.cwd);
  const lines = [
    `<b>Stopped: ${escapeHtml(errorType)}</b> · [${agentTag(session.agent)}] <code>${escapeHtml(label)}</code>`,
  ];
  if (session.currentTask) {
    lines.push(`<i>Task: ${escapeHtml(truncate(session.currentTask, 200))}</i>`);
  }
  if (errorMessage) {
    lines.push("", `<pre>${escapeHtml(truncate(errorMessage, 400))}</pre>`);
  }
  return lines.join("\n");
}

export function renderStoppedMessage(
  session: Session,
  lastAssistantMessage: string,
): string {
  const label = cwdLabel(session.cwd);
  const lines = [
    `<b>Done</b> · [${agentTag(session.agent)}] <code>${escapeHtml(label)}</code>`,
  ];
  if (session.currentTask) {
    lines.push(`<i>Task: ${escapeHtml(truncate(session.currentTask, 200))}</i>`);
  }
  if (lastAssistantMessage) {
    lines.push(
      "",
      `<pre>${escapeHtml(truncate(lastAssistantMessage, 600))}</pre>`,
    );
  }
  return lines.join("\n");
}

export function renderToolRanMessage(
  approval: PendingApproval,
  toolResponse: Record<string, unknown> | null,
): string {
  const label = cwdLabel(approval.cwd);
  const toolSummary = summarizeTool(approval.toolName, approval.toolInput);
  const outcome = summarizeToolResponse(toolResponse);
  const lines = [
    `<b>Approved in terminal</b> · [${agentTag(approval.agent)}] <code>${escapeHtml(label)}</code>`,
    `<i>${escapeHtml(approval.toolName)}</i>`,
    "",
    `<pre>${escapeHtml(toolSummary)}</pre>`,
  ];
  if (outcome) {
    lines.push(`<i>${escapeHtml(outcome)}</i>`);
  }
  return lines.join("\n");
}

function summarizeToolResponse(
  toolResponse: Record<string, unknown> | null,
): string | null {
  if (!toolResponse) return null;
  if (toolResponse.interrupted === true) {
    return "Tool was interrupted.";
  }
  if (
    typeof toolResponse.stderr === "string" &&
    toolResponse.stderr.length > 0 &&
    typeof toolResponse.stdout === "string" &&
    toolResponse.stdout.length === 0
  ) {
    return "Tool exited with stderr output.";
  }
  return null;
}

function agentTag(agent: "claude" | "codex"): string {
  return agent === "claude" ? "Claude" : "Codex";
}

export function shortId(sessionId: string): string {
  return sessionId.slice(0, 6);
}

export function renderSessionLine(s: Session): string {
  const ago = formatAge(Date.now() - s.lastSeen);
  const parts = [
    `• [${agentTag(s.agent)}] ${shortId(s.id)} ${s.label} — ${ago} ago`,
    `  ${s.cwd}`,
  ];
  if (s.currentTask) {
    parts.push(`  Task: ${truncate(s.currentTask, 120)}`);
  }
  return parts.join("\n");
}

export function renderBindingLine(
  sessionId: string,
  binding: { target: string; source: "auto" | "manual"; boundAt: number },
): string {
  // Look up the session for a friendly label; fall back to the raw id if the
  // session was pruned but the binding hasn't been cleaned up yet.
  const session = getSession(sessionId);
  const label = session ? session.label : "(unknown)";
  const ago = formatAge(Date.now() - binding.boundAt);
  return (
    `<code>${escapeHtml(shortId(sessionId))}</code> ${escapeHtml(label)} → ` +
    `<code>${escapeHtml(binding.target)}</code> (${binding.source}, ${ago} ago)`
  );
}

export function cwdLabel(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  if (parts.length <= 2) return cwd;
  return parts.slice(-2).join("/");
}

export function summarizeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
): string {
  // Common tool shapes — show the most useful field inline.
  if (typeof toolInput.command === "string") {
    return truncate(toolInput.command, 500);
  }
  if (typeof toolInput.file_path === "string") {
    const path = toolInput.file_path;
    if (typeof toolInput.content === "string") {
      return `${path}\n\n${truncate(toolInput.content, 400)}`;
    }
    return String(path);
  }
  if (typeof toolInput.url === "string") {
    return String(toolInput.url);
  }
  // Fallback: pretty-printed JSON, truncated.
  try {
    return truncate(JSON.stringify(toolInput, null, 2), 500);
  } catch {
    return `(unserializable tool input for ${toolName})`;
  }
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n... [truncated ${s.length - max} chars]`;
}

export function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
