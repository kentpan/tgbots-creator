/**
 * D1 读写额度计量 + 省电模式（v2.2.0）
 *
 * 背景：Cloudflare D1 免费版每天 500 万行读、10 万行写，按 **扫描行数** 计费
 * （不是按查询次数）。2026-11-06 线上触发
 * `D1_ERROR: Your account has exceeded D1's free tier daily row read limit`，
 * 全站不可用直到 UTC 零点。
 *
 * 本模块做两件事：
 * 1. 计量：从 D1 返回的 `meta.rows_read / meta.rows_written`（Node 形态退化为
 *    返回行数/变更行数）累计当日用量，并按 SQL 归因，供诊断端点与管理后台展示
 *    「到底是谁把额度吃掉了」。
 * 2. 熔断（省电模式）：当日读用量越过安全线后自动进入省电模式 —— 所有读缓存
 *    TTL 放大 6 倍，把剩余额度留给验证主流程，保证一整天可用。
 *
 * 状态存在 isolate 内存里（workerd 无常驻进程，多 isolate 各自计量）；因此
 * 阈值判定取「本 isolate 用量」，宁可保守提前省电，也不让额度见底。
 */

/** 免费版每日读上限（行） */
export const D1_FREE_DAILY_ROW_READS = 5_000_000;
/** 免费版每日写上限（行） */
export const D1_FREE_DAILY_ROW_WRITES = 100_000;
/** 默认安全线：留 20% 余量给后台操作与突发流量 */
export const DEFAULT_READ_SAFETY_LIMIT = 4_000_000;

interface SqlMetric {
  sql: string;
  rowsRead: number;
  rowsWritten: number;
  count: number;
}

interface MetricsState {
  day: string;
  rowsRead: number;
  rowsWritten: number;
  queries: number;
  cacheHits: number;
  cacheMisses: number;
  bySql: Map<string, SqlMetric>;
}

const MAX_TRACKED_SQL = 60;

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function freshState(): MetricsState {
  return {
    day: utcDay(),
    rowsRead: 0,
    rowsWritten: 0,
    queries: 0,
    cacheHits: 0,
    cacheMisses: 0,
    bySql: new Map(),
  };
}

const globalForMetrics = globalThis as unknown as { tguardD1Metrics?: MetricsState };

function state(): MetricsState {
  if (!globalForMetrics.tguardD1Metrics) {
    globalForMetrics.tguardD1Metrics = freshState();
  }
  const current = globalForMetrics.tguardD1Metrics;
  // D1 额度按 UTC 零点重置 —— 跨天立即归零，避免把昨天的用量算进今天
  if (current.day !== utcDay()) {
    globalForMetrics.tguardD1Metrics = freshState();
    return globalForMetrics.tguardD1Metrics;
  }
  return current;
}

/** 归一化 SQL 便于聚合归因（去空白、去参数差异、截断） */
export function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().slice(0, 180);
}

function bumpSql(sql: string, rowsRead: number, rowsWritten: number): void {
  const s = state();
  const key = normalizeSql(sql);
  const entry = s.bySql.get(key);
  if (entry) {
    entry.rowsRead += rowsRead;
    entry.rowsWritten += rowsWritten;
    entry.count += 1;
    return;
  }
  // 超出上限后不再新增归因项（避免恶意/异常 SQL 撑爆内存），但仍计数总量
  if (s.bySql.size >= MAX_TRACKED_SQL) {
    // 覆盖掉用量最小的条目，保证热门 SQL 始终在榜
    let smallestKey: string | null = null;
    let smallest = Number.POSITIVE_INFINITY;
    for (const [k, v] of s.bySql) {
      if (v.rowsRead < smallest) {
        smallest = v.rowsRead;
        smallestKey = k;
      }
    }
    if (smallestKey !== null && rowsRead > smallest) {
      s.bySql.delete(smallestKey);
    } else {
      return;
    }
  }
  s.bySql.set(key, { sql: key, rowsRead, rowsWritten, count: 1 });
}

export function recordRead(sql: string, rowsRead: number): void {
  const s = state();
  const rows = Number.isFinite(rowsRead) ? Math.max(0, Math.trunc(rowsRead)) : 0;
  s.rowsRead += rows;
  s.queries += 1;
  bumpSql(sql, rows, 0);
}

export function recordWrite(sql: string, rowsWritten: number, scannedRows = 0): void {
  const s = state();
  const written = Number.isFinite(rowsWritten) ? Math.max(0, Math.trunc(rowsWritten)) : 0;
  // 写语句同样会扫描行（UPDATE/DELETE 的 WHERE 命中过程），一起计入读用量
  const scanned = Number.isFinite(scannedRows) ? Math.max(0, Math.trunc(scannedRows)) : 0;
  s.rowsWritten += written;
  s.rowsRead += scanned;
  s.queries += 1;
  bumpSql(sql, scanned, written);
}

export function recordCacheHit(): void {
  state().cacheHits += 1;
}

export function recordCacheMiss(): void {
  state().cacheMisses += 1;
}

/** 安全线（可用环境变量 D1_DAILY_READ_BUDGET 覆盖，单位：行） */
export function readSafetyLimit(): number {
  const raw = Number(process.env.D1_DAILY_READ_BUDGET);
  if (Number.isFinite(raw) && raw > 0) return Math.trunc(raw);
  return DEFAULT_READ_SAFETY_LIMIT;
}

/**
 * 省电模式：当日读用量越过安全线 → 缓存 TTL 放大，优先保命。
 * 也可用环境变量 D1_FRUGAL_MODE=1 强制开启（验证压测/排障时用）。
 */
export function isFrugalMode(): boolean {
  if (process.env.D1_FRUGAL_MODE === "1") return true;
  return state().rowsRead >= readSafetyLimit();
}

export interface D1UsageSnapshot {
  day: string;
  rowsRead: number;
  rowsWritten: number;
  queries: number;
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number;
  readLimit: number;
  readLimitFree: number;
  writeLimitFree: number;
  readPercent: number;
  writePercent: number;
  frugalMode: boolean;
  topQueries: { sql: string; rowsRead: number; rowsWritten: number; count: number }[];
}

export function getD1Usage(): D1UsageSnapshot {
  const s = state();
  const limit = readSafetyLimit();
  const topQueries = Array.from(s.bySql.values())
    .sort((a, b) => b.rowsRead - a.rowsRead)
    .slice(0, 15);
  const total = s.cacheHits + s.cacheMisses;
  return {
    day: s.day,
    rowsRead: s.rowsRead,
    rowsWritten: s.rowsWritten,
    queries: s.queries,
    cacheHits: s.cacheHits,
    cacheMisses: s.cacheMisses,
    cacheHitRate: total > 0 ? (s.cacheHits / total) * 100 : 0,
    readLimit: limit,
    readLimitFree: D1_FREE_DAILY_ROW_READS,
    writeLimitFree: D1_FREE_DAILY_ROW_WRITES,
    readPercent: (s.rowsRead / D1_FREE_DAILY_ROW_READS) * 100,
    writePercent: (s.rowsWritten / D1_FREE_DAILY_ROW_WRITES) * 100,
    frugalMode: isFrugalMode(),
    topQueries,
  };
}

/** 测试/诊断用：清零当前 isolate 的计量 */
export function resetD1Metrics(): void {
  globalForMetrics.tguardD1Metrics = freshState();
}
