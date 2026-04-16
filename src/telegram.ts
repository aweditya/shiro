import { Bot, InlineKeyboard } from "grammy";
import { config } from "./config.js";
import {
  attachTelegramMessage,
  getActiveSessions,
  getPendingApproval,
  getPendingApprovals,
  resolvePendingApproval,
} from "./state.js";
import type { PendingApproval } from "./types.js";

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
        lines.push(`• [${agentTag(s.agent)}] ${s.label} (${ago} ago)`);
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
    const lines = sessions.map((s) => {
      const ago = formatAge(Date.now() - s.lastSeen);
      return `• [${agentTag(s.agent)}] ${s.label} — ${ago} ago\n  ${s.cwd}`;
    });
    await ctx.reply(lines.join("\n"));
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

function renderApprovalMessage(approval: PendingApproval): string {
  const label = cwdLabel(approval.cwd);
  const toolSummary = summarizeTool(approval.toolName, approval.toolInput);
  return [
    `<b>[${agentTag(approval.agent)}]</b> <code>${escapeHtml(label)}</code>`,
    `<i>Permission needed: ${escapeHtml(approval.toolName)}</i>`,
    "",
    `<pre>${escapeHtml(toolSummary)}</pre>`,
  ].join("\n");
}

function renderResolvedMessage(
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

function renderTimeoutMessage(approval: PendingApproval): string {
  const label = cwdLabel(approval.cwd);
  const toolSummary = summarizeTool(approval.toolName, approval.toolInput);
  return [
    `<b>TIMED OUT · auto-denied</b> · [${agentTag(approval.agent)}] <code>${escapeHtml(label)}</code>`,
    `<i>${escapeHtml(approval.toolName)}</i>`,
    "",
    `<pre>${escapeHtml(toolSummary)}</pre>`,
  ].join("\n");
}

function renderResolvedLocallyMessage(approval: PendingApproval): string {
  const label = cwdLabel(approval.cwd);
  const toolSummary = summarizeTool(approval.toolName, approval.toolInput);
  return [
    `<b>Resolved in terminal</b> · [${agentTag(approval.agent)}] <code>${escapeHtml(label)}</code>`,
    `<i>${escapeHtml(approval.toolName)}</i>`,
    "",
    `<pre>${escapeHtml(toolSummary)}</pre>`,
  ].join("\n");
}

function agentTag(agent: "claude" | "codex"): string {
  return agent === "claude" ? "Claude" : "Codex";
}

function cwdLabel(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  if (parts.length <= 2) return cwd;
  return parts.slice(-2).join("/");
}

function summarizeTool(
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

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n... [truncated ${s.length - max} chars]`;
}

function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
