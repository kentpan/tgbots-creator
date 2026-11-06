/**
 * 边缘运行时数据维护（v2.2.0）
 *
 * 背景：Cloudflare 上无常驻进程，`runCleanupLoop`（Node 才有）不会跑 ——
 * verification_sessions / join_requests 只增不减。表越大，D1 的**扫描行数**
 * 计费越贵：一次 COUNT 全表就是几万行读。**表体积是额度成本的第一放大器**，
 * 所以在边缘侧必须有人定期归档。
 *
 * 策略：机会式执行（opportunistic）——挂在 webhook 请求链路上，用一个
 * 「1 小时一次」的门闩把成本摊薄到几乎为零：
 * - 未到期：纯内存判断，0 次 IO，直接返回；
 * - 到期：清过期管理员会话 + 分批归档超期数据（每批 400 行，最多 50 批）。
 *
 * 有 KV 绑定时用 KV 做跨 isolate 锁（1 小时 1 次写），避免每个 isolate 各跑一遍。
 */
import { getKv } from "@/database/bindings";
import { deleteExpiredAdminSessions, purgeStaleRecords } from "@/database/operations";
import { APP_SETTING_KEYS } from "@/config/runtime-settings";
import { getCachedAppSettings } from "@/database/operations";

export const HOUSEKEEPING_INTERVAL_MS = 60 * 60 * 1000;
const HOUSEKEEPING_LOCK_KEY = "housekeeping:last_run";
const DEFAULT_RETENTION_DAYS = 30;

const globalForHousekeeping = globalThis as unknown as { tguardHousekeepingAt?: number };

/**
 * 到期才真正执行维护。返回值仅用于诊断/测试：
 * - "skipped"：未到期（零 IO）
 * - "done"：本轮已归档
 * - "error"：归档异常（已吞掉，不影响调用方）
 */
export async function runHousekeepingIfDue(): Promise<"skipped" | "done" | "error"> {
  const now = Date.now();
  const last = globalForHousekeeping.tguardHousekeepingAt ?? 0;
  if (now - last < HOUSEKEEPING_INTERVAL_MS) return "skipped";

  // 先占位再执行：并发请求不会同时触发两轮归档
  globalForHousekeeping.tguardHousekeepingAt = now;
  try {
    const kv = getKv();
    if (kv.kind === "cloudflare") {
      try {
        const lastRun = await kv.get(HOUSEKEEPING_LOCK_KEY);
        if (lastRun) {
          const parsed = Number(lastRun);
          if (Number.isFinite(parsed) && now - parsed < HOUSEKEEPING_INTERVAL_MS) {
            return "skipped";
          }
        }
        await kv.set(HOUSEKEEPING_LOCK_KEY, String(now), 2 * 60 * 60);
      } catch (error) {
        // KV 异常不影响主流程：退化为「每个 isolate 每小时一次」
        console.warn("[housekeeping] KV 锁不可用，退化到 isolate 级节流:", error);
      }
    }

    const settings = await getCachedAppSettings();
    const retention = Number(settings[APP_SETTING_KEYS.cleanupRetentionDays]);
    const retentionDays =
      Number.isFinite(retention) && retention > 0 ? retention : DEFAULT_RETENTION_DAYS;

    const [purged] = await Promise.all([
      purgeStaleRecords(retentionDays),
      deleteExpiredAdminSessions().catch(() => 0),
    ]);
    if (purged.sessions > 0 || purged.join_requests > 0) {
      console.log(
        `[housekeeping] 归档完成：会话 ${purged.sessions} 行 / 加群申请 ${purged.join_requests} 行（保留 ${retentionDays} 天）`,
      );
    }
    return "done";
  } catch (error) {
    console.error("[housekeeping] 归档失败:", error);
    return "error";
  }
}

/** 测试用：重置门闩 */
export function resetHousekeepingThrottle(): void {
  globalForHousekeeping.tguardHousekeepingAt = 0;
}
