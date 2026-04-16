import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid integer for ${name}: ${value}`);
  }
  return parsed;
}

export const config = {
  botToken: required("TELEGRAM_BOT_TOKEN"),
  chatId: Number.parseInt(required("TELEGRAM_CHAT_ID"), 10),
  // Shared secret required on every hook request. Any POST to /hooks/*
  // without a matching Authorization: Bearer header is rejected.
  sharedSecret: required("SHIRO_SHARED_SECRET"),
  httpPort: optionalInt("HTTP_PORT", 7777),
  // Auto-deny safety margin (seconds) — must be less than the hook's timeout
  claudeTimeoutSeconds: optionalInt("CLAUDE_TIMEOUT_SECONDS", 55),
  codexTimeoutSeconds: optionalInt("CODEX_TIMEOUT_SECONDS", 120),
  // Prune sessions not seen in this many seconds
  sessionStaleSeconds: optionalInt("SESSION_STALE_SECONDS", 1800),
  // Stop hook fires on every turn completion. Only ping Telegram if the
  // turn took at least this long — prevents spam during interactive chat.
  // Set to 0 to notify on every Stop. Requires UserPromptSubmit to be hooked
  // up (otherwise we have no start time and skip the notification).
  stopNotifyMinSeconds: optionalInt("STOP_NOTIFY_MIN_SECONDS", 30),
} as const;

if (Number.isNaN(config.chatId)) {
  throw new Error("TELEGRAM_CHAT_ID must be a number");
}

if (config.sharedSecret.length < 16) {
  throw new Error(
    "SHIRO_SHARED_SECRET must be at least 16 characters. Generate one with: openssl rand -hex 32",
  );
}
