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
  httpPort: optionalInt("HTTP_PORT", 7777),
  // Auto-deny safety margin (seconds) — must be less than the hook's timeout
  claudeTimeoutSeconds: optionalInt("CLAUDE_TIMEOUT_SECONDS", 55),
  codexTimeoutSeconds: optionalInt("CODEX_TIMEOUT_SECONDS", 120),
  // Prune sessions not seen in this many seconds
  sessionStaleSeconds: optionalInt("SESSION_STALE_SECONDS", 1800),
} as const;

if (Number.isNaN(config.chatId)) {
  throw new Error("TELEGRAM_CHAT_ID must be a number");
}
