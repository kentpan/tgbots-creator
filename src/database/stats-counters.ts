/**
 * 加群申请状态计数器（v2.2.0，D1 读取额度保护）
 *
 * 问题：`SELECT status, COUNT(id) FROM join_requests GROUP BY status` 在 D1 上
 * 按 **扫描行数** 计费 —— join_requests 累积到几万行后，看板/机器人菜单每刷新
 * 一次就是几万行读。免费版 500 万行/天，几十次刷新就打穿额度（2026-11-06 线上
 * 事故根因之一）。
 *
 * 方案：把「按状态的累计数量」维护成 **8 行小表** stats_counters，只在状态
 * 真正发生迁移时做增量更新（+1/-1），读取恒定 8 行。
 *
 * 一致性保障：
 * - 所有迁移都挂在 approveJoinRequest / rejectJoinRequest / createJoinRequest /
 *   cleanupExpiredSessions / purgeStaleRecords 上，用 UPDATE 的 changes 判定
 *   是否真的迁移过（幂等重复调用不会重复计数）。
 * - 首读时若计数器为空 → 用一次性 GROUP BY 播种（只发生一次）。
 * - 提供 recalculateJoinRequestCounters() 供管理端「统计自愈」全量重算。
 *
 * 「今日」统计**不走计数器**：给 join_requests.request_time 建索引后，
 * 今日范围扫描只碰当天几十行，既精确又便宜。
 */
import { executeRun, queryAll } from "@/database/client";

export const JOIN_REQUEST_COUNTER_TOTAL = "jr_total";
export const JOIN_REQUEST_COUNTER_STATUS_PREFIX = "jr_status_";
export const JOIN_REQUEST_STATUSES = ["pending", "approved", "rejected", "expired"] as const;

const globalForCounterState = globalThis as unknown as {
  tguardCounterReady?: boolean;
  tguardCounterUnavailable?: boolean;
  tguardCounterSeeding?: Promise<void> | null;
};

function counterName(status: string): string {
  return `${JOIN_REQUEST_COUNTER_STATUS_PREFIX}${status}`;
}

function dateText(date: Date): string {
  return date.toISOString();
}

async function addCounter(name: string, delta: number): Promise<void> {
  if (!Number.isFinite(delta) || delta === 0) return;
  await executeRun(
    `INSERT INTO stats_counters (name, value, updated_time) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET value = value + excluded.value, updated_time = excluded.updated_time`,
    [name, Math.trunc(delta), dateText(new Date())],
  );
}

/**
 * 绝对值写入（仅播种用）：并发播种时结果一致（幂等），
 * 不会像增量写法那样被两个 isolate 各加一遍而翻倍。
 */
async function setCounter(name: string, value: number): Promise<void> {
  await executeRun(
    `INSERT INTO stats_counters (name, value, updated_time) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_time = excluded.updated_time`,
    [name, Math.trunc(value), dateText(new Date())],
  );
}

/** 申请新增（pending） */
export async function bumpJoinRequestInserted(count = 1): Promise<void> {
  if (count <= 0) return;
  await addCounter(JOIN_REQUEST_COUNTER_TOTAL, count);
  await addCounter(counterName("pending"), count);
}

/**
 * 状态迁移计数：只对**真实发生**的迁移调用（调用方用 UPDATE 的 changes 判定）。
 * `from` 为 null 表示来源状态未知（脏数据自愈），此时只加不减，避免负值。
 */
export async function bumpJoinRequestTransition(
  from: string | null,
  to: string,
  count = 1,
): Promise<void> {
  if (count <= 0 || !to) return;
  if (from && from === to) return;
  if (from) await addCounter(counterName(from), -count);
  await addCounter(counterName(to), count);
}

/**
 * 归档/删除后的批量扣减：`status` 为 null 时只扣总量。
 * （purgeStaleRecords 删除前已按状态聚合出待删行，这里只做账）
 */
export async function addCounterDelta(status: string | null, delta: number): Promise<void> {
  if (!Number.isFinite(delta) || delta === 0) return;
  if (status === null) {
    await addCounter(JOIN_REQUEST_COUNTER_TOTAL, delta);
    return;
  }
  await addCounter(counterName(status), delta);
}

export interface JoinRequestCounters {
  total: number;
  byStatus: Record<string, number>;
}

/**
 * 读取计数器（stats_counters 属可缓存表，TTL 20s → 实读极低）。
 * 计数器尚未播种时返回 null，调用方回退到 legacy GROUP BY。
 */
export async function readJoinRequestCounters(): Promise<JoinRequestCounters | null> {
  if (globalForCounterState.tguardCounterUnavailable) return null;
  try {
    const rows = await queryAll<{ name: string; value: number }>(
      `SELECT name, value FROM stats_counters WHERE name LIKE 'jr\\_%' ESCAPE '\\'`,
    );
    if (rows.length === 0) return null;
    let total: number | null = null;
    const byStatus: Record<string, number> = {};
    for (const row of rows) {
      const value = Number(row.value) || 0;
      if (row.name === JOIN_REQUEST_COUNTER_TOTAL) {
        total = value;
      } else if (row.name.startsWith(JOIN_REQUEST_COUNTER_STATUS_PREFIX)) {
        byStatus[row.name.slice(JOIN_REQUEST_COUNTER_STATUS_PREFIX.length)] = value;
      }
    }
    if (total === null) return null;
    return { total, byStatus };
  } catch (error) {
    // stats_counters 表不存在（D1 未迁移）→ 本次运行期永久回退，不再反复触发错误
    globalForCounterState.tguardCounterUnavailable = true;
    console.warn(
      "stats_counters 不可用，统计回落为 GROUP BY（请重新部署以应用 D1 schema）:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/** 一次性播种：把历史数据折算进计数器（只在该表为空时执行） */
export async function ensureJoinRequestCounters(): Promise<void> {
  if (globalForCounterState.tguardCounterReady) return;
  if (globalForCounterState.tguardCounterUnavailable) return;
  if (globalForCounterState.tguardCounterSeeding) {
    await globalForCounterState.tguardCounterSeeding;
    return;
  }
  const task = (async () => {
    const existing = await readJoinRequestCounters();
    if (existing) {
      globalForCounterState.tguardCounterReady = true;
      return;
    }
    // 首次（或计数器被清空）：一次性 GROUP BY 播种。此后所有路径只做增量。
    const rows = await queryAll<{ status: string; count: number }>(
      `SELECT status, COUNT(id) AS count FROM join_requests GROUP BY status`,
    );
    let total = 0;
    const seeded: Record<string, number> = {};
    for (const status of JOIN_REQUEST_STATUSES) seeded[status] = 0;
    for (const row of rows) {
      const count = Number(row.count) || 0;
      total += count;
      seeded[String(row.status)] = count;
    }
    // 绝对值写入：并发播种（多 isolate 同时冷启动）结果幂等，不会翻倍
    for (const [status, count] of Object.entries(seeded)) {
      await setCounter(counterName(status), count);
    }
    await setCounter(JOIN_REQUEST_COUNTER_TOTAL, total);
    globalForCounterState.tguardCounterReady = true;
    console.log(`[stats] 加群申请计数器已播种：total=${total}`);
  })();
  globalForCounterState.tguardCounterSeeding = task;
  try {
    await task;
  } finally {
    globalForCounterState.tguardCounterSeeding = null;
  }
}

/** 管理端「统计自愈」：按当前数据全量重算（一次性全表扫描，低频操作） */
export async function recalculateJoinRequestCounters(): Promise<JoinRequestCounters> {
  const rows = await queryAll<{ status: string; count: number }>(
    `SELECT status, COUNT(id) AS count FROM join_requests GROUP BY status`,
  );
  let total = 0;
  const byStatus: Record<string, number> = {};
  for (const status of JOIN_REQUEST_STATUSES) byStatus[status] = 0;
  for (const row of rows) {
    const status = String(row.status);
    const count = Number(row.count) || 0;
    total += count;
    byStatus[status] = (byStatus[status] ?? 0) + count;
  }
  await executeRun(`DELETE FROM stats_counters WHERE name LIKE 'jr\\_%' ESCAPE '\\'`);
  for (const [status, count] of Object.entries(byStatus)) {
    await addCounter(counterName(status), count);
  }
  await addCounter(JOIN_REQUEST_COUNTER_TOTAL, total);
  globalForCounterState.tguardCounterReady = true;
  globalForCounterState.tguardCounterUnavailable = false;
  return { total, byStatus };
}
