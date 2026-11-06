import { recordRead, recordWrite } from "@/database/d1-metrics";
import {
  invalidateAllReadCache,
  invalidateForWrite,
  planQueryCache,
  readThroughCache,
} from "@/database/read-cache";

export type SqlParam = string | number | bigint | Uint8Array | null;

export type SqlRow = Record<string, unknown>;

export interface SqlRunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface SqlDatabase {
  readonly kind: "node" | "d1";
  readonly displayPath: string;
  all<T extends SqlRow = SqlRow>(sql: string, params?: SqlParam[]): Promise<T[]>;
  run(sql: string, params?: SqlParam[]): Promise<SqlRunResult>;
  exec(sql: string): Promise<void>;
}

interface NodeSqliteStatement {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

interface NodeSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): NodeSqliteStatement;
  close(): void;
}

interface D1PreparedStatementLike {
  bind(...params: unknown[]): {
    all(): Promise<{ results?: unknown[]; meta?: D1ResultMetaLike }>;
    run(): Promise<{ meta?: D1ResultMetaLike & { changes?: number; last_row_id?: number } }>;
  };
}

/**
 * D1 返回的 meta：`rows_read` / `rows_written` 是 Cloudflare 计费用的真实行数，
 * 拿它做额度归因比「返回行数」准确得多（全表扫描的 COUNT 返回 1 行但读了 N 行）。
 */
interface D1ResultMetaLike {
  rows_read?: number;
  rows_written?: number;
  changes?: number;
  last_row_id?: number;
}

interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  exec(sql: string): Promise<unknown>;
}

function isD1Binding(value: unknown): value is D1DatabaseLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { prepare?: unknown }).prepare === "function"
  );
}

function resolveD1FromGlobals(): D1DatabaseLike | null {
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const key of ["DATABASE", "__D1_DATABASE"]) {
    if (isD1Binding(globals[key])) return globals[key] as D1DatabaseLike;
  }
  const env = process.env as unknown as Record<string, unknown>;
  if (isD1Binding(env.DATABASE)) return env.DATABASE as D1DatabaseLike;
  return null;
}

async function resolveD1FromRequestContext(): Promise<D1DatabaseLike | null> {
  // v1.1.5: 补充 "@opennextjs/cloudflare"（OpenNext 迁移后的正式包名；
  // 原 "@opennext/cloudflare" 是不存在的包名, 永远解析失败）。
  // 请求上下文仅覆盖 handler 内调用; worker 入口层还有 globalThis 注入
  // (pages-adapter/worker.ts) 作为主路径, 本函数为兜底。
  const requestContextModules = [
    "@cloudflare/next-on-pages",
    "@opennextjs/cloudflare",
  ];
  for (const moduleName of requestContextModules) {
    try {
      const importer = new Function(
        "m",
        `return import(/* webpackIgnore: true */ m)`,
      ) as (m: string) => Promise<unknown>;
      const mod = (await importer(moduleName)) as {
        getRequestContext?: () => { env: Record<string, unknown> };
        getCloudflareContext?: () => { env: Record<string, unknown> };
      };
      const getRequestContext =
        mod.getRequestContext ?? mod.getCloudflareContext;
      if (typeof getRequestContext !== "function") continue;
      const { env } = getRequestContext();
      if (isD1Binding(env.DATABASE)) return env.DATABASE as D1DatabaseLike;
    } catch {
      continue;
    }
  }
  return null;
}

async function resolveDatabaseUri(): Promise<{ file: string; display: string }> {
  const uri = (process.env.DATABASE_URI ?? "").trim();
  if (!uri) {
    throw new Error(
      "DATABASE_URI is not configured; add it to .env (e.g. DATABASE_URI=file:./prisma/bot-groups.db)",
    );
  }
  if (uri === ":memory:" || uri === "file::memory:" || uri === "file::memory:?cache=shared") {
    return { file: ":memory:", display: ":memory:" };
  }
  let target = uri.startsWith("file:") ? uri.slice("file:".length) : uri;
  const queryIndex = target.indexOf("?");
  if (queryIndex >= 0) target = target.slice(0, queryIndex);
  if (!target) return { file: ":memory:", display: ":memory:" };
  const { getEnvBaseDir } = await import("@/lib/dotenv");
  // node:path 用动态 import（new Function 逃逸，与下方 node:sqlite 同一范式）：
  // 本模块在 Edge bundle 中被静态引用，静态 import node:path 会在模块求值时
  // "Native module not found" 炸构建（2026-11-04 CI 实测）。本函数仅 Node 形态
  // 分支（node:sqlite 数据库）会执行，Edge 形态走 D1 不会触达。
  const loadPath = new Function("return import('node:path')") as () => Promise<
    typeof import("node:path")
  >;
  const path = await loadPath();
  const absolute = path.isAbsolute(target) ? target : path.resolve(getEnvBaseDir(), target);
  return { file: absolute, display: absolute };
}

let nodeDatabase: NodeSqliteDatabase | null = null;

async function createNodeDatabase(): Promise<SqlDatabase> {
  const { file, display } = await resolveDatabaseUri();
  if (file !== ":memory:") {
    // node:fs / node:path 均走 new Function 逃逸（理由同 resolveDatabaseUri，
    // 避免 Edge bundle 中的 node: 模块引用被求值）
    const loadPath = new Function("return import('node:path')") as () => Promise<
      typeof import("node:path")
    >;
    const loadFs = new Function("return import('node:fs')") as () => Promise<
      typeof import("node:fs")
    >;
    const [{ mkdirSync }, path] = await Promise.all([loadFs(), loadPath()]);
    mkdirSync(path.dirname(file), { recursive: true });
  }
  const loader = new Function(`return import("node:sqlite")`) as () => Promise<{
    DatabaseSync: new (location: string) => NodeSqliteDatabase;
  }>;
  const { DatabaseSync } = await loader();
  if (!nodeDatabase) {
    nodeDatabase = new DatabaseSync(file);
    nodeDatabase.exec("PRAGMA journal_mode = WAL;");
    nodeDatabase.exec("PRAGMA busy_timeout = 5000;");
  }
  const db = nodeDatabase;
  return {
    kind: "node",
    displayPath: display,
    async all<T extends SqlRow = SqlRow>(sql: string, params: SqlParam[] = []): Promise<T[]> {
      const stmt = db.prepare(sql);
      const rows = stmt.all(...params) as T[];
      // Node 形态拿不到「扫描行数」，用返回行数近似（本地/自托管无额度限制）
      recordRead(sql, rows.length);
      return rows;
    },
    async run(sql: string, params: SqlParam[] = []): Promise<SqlRunResult> {
      const stmt = db.prepare(sql);
      const info = stmt.run(...params);
      recordWrite(sql, Number(info.changes), 0);
      return {
        changes: Number(info.changes),
        lastInsertRowid: Number(info.lastInsertRowid),
      };
    },
    async exec(sql: string): Promise<void> {
      db.exec(sql);
    },
  };
}

async function createD1Database(d1: D1DatabaseLike): Promise<SqlDatabase> {
  return {
    kind: "d1",
    displayPath: "cloudflare:d1(DATABASE)",
    async all<T extends SqlRow = SqlRow>(sql: string, params: SqlParam[] = []): Promise<T[]> {
      const result = await d1.prepare(sql).bind(...params).all();
      const rows = (result.results ?? []) as T[];
      // 计费口径 = rows_read（扫描行数），不是返回行数 —— 归因必须用它，
      // 否则 COUNT(*) 这类「返回 1 行、扫 10 万行」的查询会被严重低估。
      const meta = result.meta ?? {};
      recordRead(sql, typeof meta.rows_read === "number" ? meta.rows_read : rows.length);
      return rows;
    },
    async run(sql: string, params: SqlParam[] = []): Promise<SqlRunResult> {
      const result = await d1.prepare(sql).bind(...params).run();
      const meta = result.meta ?? {};
      recordWrite(
        sql,
        Number(meta.rows_written ?? meta.changes ?? 0),
        Number(meta.rows_read ?? 0),
      );
      return {
        changes: Number(meta.changes ?? 0),
        lastInsertRowid: Number(meta.last_row_id ?? 0),
      };
    },
    async exec(sql: string): Promise<void> {
      await d1.exec(sql);
    },
  };
}

const globalForDatabase = globalThis as unknown as { botGroupsDatabase?: SqlDatabase };

export async function getDatabase(): Promise<SqlDatabase> {
  if (globalForDatabase.botGroupsDatabase) {
    return globalForDatabase.botGroupsDatabase;
  }
  const existing = resolveD1FromGlobals();
  let database: SqlDatabase;
  if (existing) {
    database = await createD1Database(existing);
  } else {
    const viaContext = await resolveD1FromRequestContext();
    database = viaContext ? await createD1Database(viaContext) : await createNodeDatabase();
  }
  globalForDatabase.botGroupsDatabase = database;
  return database;
}

export async function queryAll<T extends SqlRow = SqlRow>(
  sql: string,
  params: SqlParam[] = [],
): Promise<T[]> {
  // v2.2.0 D1 额度保护：配置类表（bots/group_settings/menus/...）走 TTL 读缓存，
  // 命中即零 D1 读。未命中或非白名单表（join_requests / verification_sessions）
  // 照常直读，正确性不受影响。
  const plan = planQueryCache(sql, params);
  const load = async (): Promise<T[]> => {
    const db = await getDatabase();
    return db.all<T>(sql, params);
  };
  return plan ? readThroughCache<T[]>(plan, load) : load();
}

export async function queryOne<T extends SqlRow = SqlRow>(
  sql: string,
  params: SqlParam[] = [],
): Promise<T | null> {
  const rows = await queryAll<T>(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

export async function executeRun(sql: string, params: SqlParam[] = []): Promise<SqlRunResult> {
  const db = await getDatabase();
  const result = await db.run(sql, params);
  // 写后精确失效：只清掉读过被写表的缓存条目（同 isolate 内立即可见）
  invalidateForWrite(sql);
  return result;
}

export async function executeScript(sql: string): Promise<void> {
  const db = await getDatabase();
  await db.exec(sql);
  invalidateAllReadCache();
}

export async function getDatabaseInfo(): Promise<{
  kind: "node" | "d1";
  displayPath: string;
}> {
  const db = await getDatabase();
  return { kind: db.kind, displayPath: db.displayPath };
}
