/**
 * 中继面独立进程入口（remote 模式宿主）：
 * MIRROR_API_ID / MIRROR_API_HASH / MIRROR_SESSION_STRING / MIRROR_PROXY_BOT_TOKEN /
 * MIRROR_TARGET_BOT / MIRROR_LISTEN / MIRROR_APP_BASE_URL
 * npx tsx scripts/mirror-relay.ts
 */
import { readRelayConfig, startMirrorRelay } from "@/relay/mirror-relay";
import { loadDotEnv } from "@/lib/dotenv";

async function main(): Promise<void> {
  loadDotEnv();
  const config = await readRelayConfig();
  if (!config) {
    console.error(
      "中继面配置不完整：需要 MIRROR_API_ID / MIRROR_API_HASH / MIRROR_SESSION_STRING / MIRROR_TARGET_BOT / MIRROR_PROXY_BOT_TOKEN",
    );
    process.exit(1);
  }
  const runtime = await startMirrorRelay(config);
  await runtime.startHttpServer();
  console.log(`[mirror-relay] 独立进程已就绪（target=@${config.targetBot}，db=${config.dbPath}）`);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[mirror-relay] 收到 ${signal}，正在停止...`);
    await runtime.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("mirror-relay 启动失败:", error);
  process.exit(1);
});
