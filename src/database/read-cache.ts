/**
 * SQL 感知读缓存（v2.2.0，D1 免费额度保护）
 *
 * 设计目标：在不改业务代码的前提下，把「每个请求都要读一次的配置类表」从
 * D1 的读用量里拿掉。
 *
 * 做法：在 database/client.ts 的 queryAll() / executeRun() 两个唯一出口上插桩 ——
 * - 读：SQL 引用的表若全部命中 `CACHEABLE_TABLES` 白名单，则按「SQL + 参数」做
 *   进程内 TTL 缓存；未命中才真正打库。
 * - 写：解析 INSERT/UPDATE/DELETE 的目标表，精确失效这些表的全部缓存条目
 *   （同 isolate 内立即可见，不会读到刚写过的旧值）。
 *
 * 白名单只放**低频写、高频读**的表（机器人配置/群组设置/菜单/指令/验证方式/
 * 管理员与权限）。加入群申请、验证会话这类高频写表**绝不缓存**，正确性优先。
 *
 * 跨 isolate 说明：workerd 每个 isolate 各有内存，冷启动会重新读一次 —— 但
 * 这些表的总行数都是个位数到几十行，代价可忽略；真正的额度杀手是
 * join_requests / verification_sessions 上的全表聚合（见 stats-counters.ts）。
 */
import { recordCacheHit, recordCacheMiss, isFrugalMode } from "@/database/d1-metrics";

/**
 * 可缓存表 → TTL（秒）。取「读该表的所有 TTL 最小值」作为整条 SQL 的 TTL，
 * 保证一个查询不会因为 JOIN 了大 TTL 表而变旧。
 */
export const CACHEABLE_TABLES: Record<string, number> = {
  app_settings: 30,
  bots: 45,
  group_settings: 20,
  group_bot_admins: 20,
  menus: 300,
  bot_commands: 120,
  verification_methods: 300,
  roles: 300,
  permissions: 300,
  role_permissions: 300,
  admin_users: 60,
  admin_sessions: 15,
  stats_counters: 20,
};

/** 省电模式下 TTL 放大倍数（额度告急时把剩余额度留给验证主流程） */
const FRUGAL_TTL_MULTIPLIER = 6;
const MAX_CACHE_ENTRIES = 1500;

interface CacheEntry {
  value: unknown;
  expiresAt: number;
  tables: string[];
}

const store = new Map<string, CacheEntry>();
/** 表 → 缓存键集合（写操作按表精确失效，避免全量清空） */
const byTable = new Map<string, Set<string>>();
/** 并发去重：同一 (SQL, 参数) 在飞行中只打一次库 */
const inflight = new Map<string, Promise<unknown>>();

const globalForCache = globalThis as unknown as {
  tguardReadCache?: {
    store: Map<string, CacheEntry>;
    byTable: Map<string, Set<string>>;
    inflight: Map<string, Promise<unknown>>;
  };
};

// workerd 里模块可能被多次求值，缓存必须挂在 globalThis 上才不会随模块实例丢失
const cache = (() => {
  if (!globalForCache.tguardReadCache) {
    globalForCache.tguardReadCache = { store, byTable, inflight };
  }
  return globalForCache.tguardReadCache;
})();

const IDENT = String.raw`"?([A-Za-z_][A-Za-z0-9_]*)"?`;
const FROM_RE = new RegExp(String.raw`\b(?:from|join)\s+${IDENT}`, "gi");
const WRITE_RE = new RegExp(
  String.raw`\b(?:insert\s+(?:or\s+[a-z]+\s+)?into|replace\s+into|update|delete\s+from)\s+${IDENT}`,
  "gi",
);

function uniqueTables(matches: Iterable<RegExpExecArray>): string[] {
  const set = new Set<string>();
  for (const match of matches) {
    const name = match[1]?.toLowerCase();
    if (name) set.add(name);
  }
  return Array.from(set);
}

/**
 * 解析 SELECT 引用的表。
 * 返回 null 表示「不可缓存」：非 SELECT、含 CTE/子查询表别名风险、含 PRAGMA 等。
 */
export function planQueryCache(
  sql: string,
  params: readonly unknown[],
): { key: string; tables: string[]; ttlSeconds: number } | null {
  const trimmed = sql.trimStart();
  if (!/^select\b/i.test(trimmed)) return null;
  // PRAGMA / 系统表 / 显式要求直读的场景一律不缓存
  if (/\bpragma\b|\bsqlite_/i.test(trimmed)) return null;
  // WITH ... 的 CTE 名不是真表，无法安全判定依赖，直接放行
  if (/^with\b/i.test(trimmed)) return null;

  const tables = uniqueTables(trimmed.matchAll(FROM_RE));
  if (tables.length === 0) return null;

  let ttl = Number.POSITIVE_INFINITY;
  for (const table of tables) {
    const tableTtl = CACHEABLE_TABLES[table];
    // 引用了任何非白名单表 → 整条 SQL 不缓存（例如 join_requests）
    if (tableTtl === undefined) return null;
    ttl = Math.min(ttl, tableTtl);
  }
  if (!Number.isFinite(ttl)) return null;

  const effectiveTtl = isFrugalMode() ? Math.min(ttl * FRUGAL_TTL_MULTIPLIER, 3600) : ttl;
  return { key: `${trimmed}::${serializeParams(params)}`, tables, ttlSeconds: effectiveTtl };
}

/** 解析写语句的目标表（用于精确失效） */
export function extractWriteTables(sql: string): string[] {
  return uniqueTables(sql.matchAll(WRITE_RE));
}

export function serializeParams(params: readonly unknown[]): string {
  if (params.length === 0) return "";
  return params
    .map((param) => {
      if (param === null || param === undefined) return "null";
      if (typeof param === "bigint") return `${param.toString()}n`;
      if (param instanceof Uint8Array) return `blob:${param.byteLength}`;
      if (typeof param === "object") {
        try {
          return JSON.stringify(param);
        } catch {
          return "obj";
        }
      }
      return `${typeof param}:${String(param)}`;
    })
    .join("\u0001");
}

function trackEntry(key: string, tables: string[]): void {
  for (const table of tables) {
    let keys = cache.byTable.get(table);
    if (!keys) {
      keys = new Set();
      cache.byTable.set(table, keys);
    }
    keys.add(key);
  }
}

function dropEntry(key: string): void {
  const entry = cache.store.get(key);
  cache.store.delete(key);
  if (!entry) return;
  for (const table of entry.tables) {
    cache.byTable.get(table)?.delete(key);
  }
}

function evictIfNeeded(): void {
  if (cache.store.size <= MAX_CACHE_ENTRIES) return;
  // Map 保持插入顺序 → 从头删最老的条目（近似 LRU，读命中会重插到末尾）
  const overflow = cache.store.size - MAX_CACHE_ENTRIES;
  let removed = 0;
  for (const key of cache.store.keys()) {
    dropEntry(key);
    if (++removed >= overflow) break;
  }
}

export async function readThroughCache<T>(
  plan: { key: string; tables: string[]; ttlSeconds: number },
  loader: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const cached = cache.store.get(plan.key);
  if (cached) {
    if (cached.expiresAt > now) {
      recordCacheHit();
      // 提升为「最近使用」：删后重插，保证淘汰顺序近似 LRU
      cache.store.delete(plan.key);
      cache.store.set(plan.key, cached);
      return cached.value as T;
    }
    dropEntry(plan.key);
  }

  const pending = cache.inflight.get(plan.key);
  if (pending) {
    recordCacheHit();
    return (await pending) as T;
  }

  recordCacheMiss();
  const task = (async () => {
    const value = await loader();
    cache.store.set(plan.key, {
      value,
      // 0 TTL 表示明确不缓存（省电模式也不会放宽到这里）
      expiresAt: Date.now() + Math.max(1, plan.ttlSeconds) * 1000,
      tables: plan.tables,
    });
    trackEntry(plan.key, plan.tables);
    evictIfNeeded();
    return value;
  })();

  cache.inflight.set(plan.key, task);
  try {
    return (await task) as T;
  } finally {
    cache.inflight.delete(plan.key);
  }
}

/** 写操作后精确失效：只清掉读过这些表的缓存条目 */
export function invalidateTables(tables: readonly string[]): void {
  for (const table of tables) {
    const keys = cache.byTable.get(table);
    if (!keys || keys.size === 0) continue;
    for (const key of Array.from(keys)) dropEntry(key);
    cache.byTable.delete(table);
  }
}

/** 写语句统一入口：解析目标表并失效对应缓存 */
export function invalidateForWrite(sql: string): void {
  const tables = extractWriteTables(sql);
  if (tables.length > 0) invalidateTables(tables);
}

export function invalidateAllReadCache(): void {
  cache.store.clear();
  cache.byTable.clear();
}

export interface ReadCacheStats {
  entries: number;
  tables: { table: string; entries: number }[];
}

export function getReadCacheStats(): ReadCacheStats {
  return {
    entries: cache.store.size,
    tables: Array.from(cache.byTable.entries())
      .map(([table, keys]) => ({ table, entries: keys.size }))
      .sort((a, b) => b.entries - a.entries),
  };
}

/**
 * 聚合结果缓存（统计/计数类）：这些查询会全表扫描，必须限频。
 *
 * 与表级缓存不同，聚合缓存**不参与写失效**（join_requests 每秒都在写，
 * 精确失效等于没有缓存），只靠 TTL 兜底。TTL 内的统计值允许轻微滞后 ——
 * 统计看板不是账本，秒级延迟可以接受，额度不可以。
 */
const aggregateStore = new Map<string, { value: unknown; expiresAt: number }>();
const globalForAggregate = globalThis as unknown as {
  tguardAggregateCache?: Map<string, { value: unknown; expiresAt: number }>;
};

function aggregates(): Map<string, { value: unknown; expiresAt: number }> {
  if (!globalForAggregate.tguardAggregateCache) {
    globalForAggregate.tguardAggregateCache = aggregateStore;
  }
  return globalForAggregate.tguardAggregateCache;
}

export async function cachedAggregate<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
): Promise<T> {
  const storeRef = aggregates();
  const now = Date.now();
  const hit = storeRef.get(key);
  if (hit && hit.expiresAt > now) {
    recordCacheHit();
    return hit.value as T;
  }
  recordCacheMiss();
  const effectiveTtl = isFrugalMode() ? Math.min(ttlSeconds * FRUGAL_TTL_MULTIPLIER, 3600) : ttlSeconds;
  const value = await loader();
  storeRef.set(key, { value, expiresAt: Date.now() + Math.max(1, effectiveTtl) * 1000 });
  return value;
}

/** 写状态迁移后主动失效聚合缓存（可选：只有确知语义的地方才调） */
export function invalidateAggregate(key: string): void {
  aggregates().delete(key);
}

export function clearAggregateCache(): void {
  aggregates().clear();
}
