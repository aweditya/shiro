// Imported first by every test file that loads modules importing src/config.ts.
// config.ts validates env at module load time and throws if anything required
// is missing — set placeholder values here so tests don't need real creds.
process.env.TELEGRAM_BOT_TOKEN = "test:bot-token";
process.env.TELEGRAM_CHAT_ID = "123";
process.env.SHIRO_SHARED_SECRET = "test-secret-at-least-16-chars-long";
process.env.HTTP_PORT = "0"; // 0 = OS picks a free port when tests need to listen
process.env.CLAUDE_TIMEOUT_SECONDS = "1";
process.env.CODEX_TIMEOUT_SECONDS = "1";
// Disable the Stop-notification duration filter for integration tests; the
// filter logic is unit-tested directly in shouldNotifyStop tests.
process.env.STOP_NOTIFY_MIN_SECONDS = "0";
