/**
 * 手动同步线上加群申请到本地库：
 *   SYNC_REMOTE_URL=https://tgbots.ccwu.cc SYNC_REMOTE_SECRET=<MIRROR_RELAY_SECRET> \
 *     npx tsx scripts/sync-join-requests.ts
 * 自动同步由清理循环承担（配置环境变量后每 5 分钟一次）。
 */
import { loadDotEnv } from "@/lib/dotenv";
import { syncRemoteJoinRequests } from "@/services/join-request-sync";

async function main(): Promise<void> {
  loadDotEnv();
  const result = await syncRemoteJoinRequests();
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
  console.log(result.message);
}

main().catch((error) => {
  console.error("join-request 同步执行失败:", error);
  process.exit(1);
});
