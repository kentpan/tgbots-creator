import path from "node:path";

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
    all(): Promise<{ results?: unknown[] }>;
    run(): Promise<{ meta?: { changes?: number; last_row_id?: number } }>;
  };
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
  const requestContextModules = [
    "@cloudflare/next-on-pages",
    "@opennext/cloudflare",
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
  const absolute = path.isAbsolute(target) ? target : path.resolve(getEnvBaseDir(), target);
  return { file: absolute, display: absolute };
}

let nodeDatabase: NodeSqliteDatabase | null = null;

async function createNodeDatabase(): Promise<SqlDatabase> {
  const { file, display } = await resolveDatabaseUri();
  if (file !== ":memory:") {
    const { mkdirSync } = await import("node:fs");
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
      return stmt.all(...params) as T[];
    },
    async run(sql: string, params: SqlParam[] = []): Promise<SqlRunResult> {
      const stmt = db.prepare(sql);
      const info = stmt.run(...params);
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
      return (result.results ?? []) as T[];
    },
    async run(sql: string, params: SqlParam[] = []): Promise<SqlRunResult> {
      const result = await d1.prepare(sql).bind(...params).run();
      const meta = result.meta ?? {};
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
  const db = await getDatabase();
  return db.all<T>(sql, params);
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
  return db.run(sql, params);
}

export async function executeScript(sql: string): Promise<void> {
  const db = await getDatabase();
  await db.exec(sql);
}

export async function getDatabaseInfo(): Promise<{
  kind: "node" | "d1";
  displayPath: string;
}> {
  const db = await getDatabase();
  return { kind: db.kind, displayPath: db.displayPath };
}
