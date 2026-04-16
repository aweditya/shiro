import { config } from "./config.js";
import { createHttpServer } from "./http-server.js";
import { pruneStaleSessions } from "./state.js";
import { createBot } from "./telegram.js";

async function main(): Promise<void> {
  const bot = createBot();
  const server = createHttpServer(bot);

  // Periodically prune sessions we haven't heard from
  const pruneInterval = setInterval(() => {
    const removed = pruneStaleSessions(config.sessionStaleSeconds);
    if (removed > 0) {
      console.log(`Pruned ${removed} stale session(s).`);
    }
  }, 60_000);
  pruneInterval.unref();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.httpPort, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  console.log(
    `HTTP server listening on http://127.0.0.1:${config.httpPort}`,
  );

  // Start long polling
  bot.start({
    onStart: (info) => {
      console.log(`Telegram bot started as @${info.username}`);
      console.log("Control plane ready.");
    },
  });

  const shutdown = (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    void bot.stop();
    server.close(() => process.exit(0));
    // Safety: force-exit if server doesn't close quickly
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
