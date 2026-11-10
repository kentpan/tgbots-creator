/**
 * import-file — 本地备份文件导入（v2.2.4）。
 *
 * 支持 .sql / .db / .json 三种格式（与导出格式同源）：
 *   - .sql : 本项目导出的 DELETE+INSERT 语句文本（容忍含 CREATE TABLE / 注释）；
 *   - .db  : SQLite 快照二进制（node:sqlite 只读打开；仅本地 Node 驱动支持）；
 *   - .json: { tables: { 表名: 行[] } } envelope（与导出/回灌格式同源）。
 *
 * 两段式：analyze（解析文件 → 表清单/行数/本地库存在性/运行环境支持判定）→
 * apply（按选中表「整表覆盖」导入：补缺失列 → 建缺失表 → DELETE + INSERT）。
 *
 * 运行环境判定（需求：需要判断运行环境支持导入到 D1）：
 *   - Node SQLite：三种格式全部支持；
 *   - Cloudflare D1：.db 二进制无法解析（Workers 无 SQLite 引擎）→ 不支持并如实提示，
 *     .sql / .json 支持（语句分块执行）。
 *
 * 覆盖语义：选中表先 DELETE 全表再写入文件内容 —— 与 .sql 导出「整表替换」一致；
 * 与备份列表「导入」的 PK upsert 语义不同（那是回灌合并，这是覆盖替换）。
 */
import type { SqlDatabase, SqlRow } from "@/database/client";
import { driverOf } from "./backup-runner";

export type ImportFileType = "sql" | "db" | "json";

export interface ImportFileTableInfo {
  name: string;
  /** 文件内的行数（.sql = INSERT 语句条数；.db/.json = 行数） */
  rows: number;
  /** 本地库中是否已存在同名表 */
  exists_in_db: boolean;
  /** 文件携带的建表语句（.db = sqlite_master.sql；.sql = 文件内 CREATE TABLE） */
  create_sql?: string;
  /** 文件内出现过的列（用于本地缺列时自动补齐） */
  columns?: string[];
}

export interface ImportAnalysis {
  file_name: string;
  file_type: ImportFileType;
  file_size: number;
  /** 当前数据库驱动（node | d1） */
  driver: string;
  /** 当前运行环境是否支持导入该文件 */
  supported: boolean;
  unsupported_reason: string;
  tables: ImportFileTableInfo[];
}

export interface ImportTableReport {
  deleted: number;
  imported: number;
  created: boolean;
  added_columns: string[];
  error: string;
}

export type ImportReport = Record<string, ImportTableReport>;

export const IMPORT_FILE_MAX_BYTES = 50 * 1024 * 1024;

export function importFileTypeOf(fileName: string): ImportFileType | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".sql")) return "sql";
  if (lower.endsWith(".db") || lower.endsWith(".sqlite") || lower.endsWith(".sqlite3")) return "db";
  if (lower.endsWith(".json")) return "json";
  return null;
}

function validIdent(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/** 引号感知的 SQL 语句切分（单引号字符串 '' 转义；-- 行注释直接丢弃，避免粘在语句头部影响识别）。 */
export function splitSqlStatements(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inStr = false;
  let inComment = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inComment) {
      if (ch === "\n") {
        inComment = false;
        cur += ch;
      }
      continue;
    }
    if (!inStr && ch === "-" && text[i + 1] === "-") {
      inComment = true;
      continue;
    }
    if (ch === "'") {
      if (inStr && text[i + 1] === "'") {
        cur += "''";
        i += 1;
        continue;
      }
      inStr = !inStr;
      cur += ch;
      continue;
    }
    if (ch === ";" && !inStr) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function tableNameOf(statement: string, keyword: "DELETE" | "INSERT" | "CREATE"): string {
  const m = statement.match(
    new RegExp(`^${keyword}\\s+(?:TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+|TABLE\\s+|FROM\\s+|INTO\\s+)?[\\["\`]*([A-Za-z_][A-Za-z0-9_]*)`, "i"),
  );
  return m ? m[1] : "";
}

function columnsOfInsert(statement: string): string[] {
  const m = statement.match(/^INSERT\s+INTO\s+[A-Za-z_][A-Za-z0-9_]*\s*\((.*?)\)\s*VALUES/i);
  if (!m) return [];
  return m[1].split(",").map((c) => c.trim()).filter(Boolean);
}

/** sqlite_master 查表是否存在（库中真实 schema 为准）。 */
async function tableExists(db: SqlDatabase, name: string): Promise<boolean> {
  const rows = await db.all<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [name],
  );
  return rows.length > 0;
}

async function dbColumnsOf(db: SqlDatabase, table: string): Promise<string[]> {
  if (!validIdent(table)) return [];
  const rows = await db.all<{ name: string }>(`PRAGMA table_info(${table})`);
  return rows.map((r) => r.name);
}

// ---------------------------------------------------------------------------
// .json 解析
// ---------------------------------------------------------------------------

interface JsonEnvelope {
  tables?: Record<string, unknown>;
}

function jsonTablesOf(text: string): Record<string, unknown[]> {
  const parsed = JSON.parse(text) as JsonEnvelope | Record<string, unknown>;
  const raw = ((parsed as JsonEnvelope).tables ?? parsed) as Record<string, unknown>;
  const tables: Record<string, unknown[]> = {};
  for (const [name, rows] of Object.entries(raw)) {
    if (!validIdent(name) || !Array.isArray(rows)) continue;
    tables[name] = rows;
  }
  return tables;
}

function columnsOfJsonRows(rows: unknown[]): string[] {
  const cols: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    for (const key of Object.keys(row as SqlRow)) {
      if (!cols.includes(key)) cols.push(key);
    }
  }
  return cols;
}

// ---------------------------------------------------------------------------
// analyze
// ---------------------------------------------------------------------------

async function analyzeSql(db: SqlDatabase, fileName: string, text: string): Promise<ImportAnalysis> {
  const statements = splitSqlStatements(text);
  const order: string[] = [];
  const info = new Map<string, ImportFileTableInfo>();
  for (const st of statements) {
    const upper = st.toUpperCase();
    if (upper.startsWith("CREATE TABLE")) {
      const name = tableNameOf(st, "CREATE");
      if (!name) continue;
      let entry = info.get(name);
      if (!entry) {
        entry = { name, rows: 0, exists_in_db: await tableExists(db, name), create_sql: st };
        info.set(name, entry);
        order.push(name);
      }
      if (!entry.create_sql) entry.create_sql = st;
      continue;
    }
    if (upper.startsWith("INSERT INTO")) {
      const name = tableNameOf(st, "INSERT");
      if (!name) continue;
      let entry = info.get(name);
      if (!entry) {
        entry = { name, rows: 0, exists_in_db: await tableExists(db, name), columns: [] };
        info.set(name, entry);
        order.push(name);
      }
      entry.rows += 1;
      for (const col of columnsOfInsert(st)) {
        if (entry.columns && !entry.columns.includes(col)) entry.columns.push(col);
      }
      continue;
    }
    if (upper.startsWith("DELETE FROM")) {
      const name = tableNameOf(st, "DELETE");
      if (!name) continue;
      let entry = info.get(name);
      if (!entry) {
        entry = { name, rows: 0, exists_in_db: await tableExists(db, name), columns: [] };
        info.set(name, entry);
        order.push(name);
      }
    }
  }
  return {
    file_name: fileName,
    file_type: "sql",
    file_size: Buffer.byteLength(text),
    driver: driverOf(db),
    supported: true,
    unsupported_reason: "",
    tables: order.map((n) => info.get(n) as ImportFileTableInfo),
  };
}

async function analyzeJson(db: SqlDatabase, fileName: string, text: string): Promise<ImportAnalysis> {
  const tables = jsonTablesOf(text);
  const out: ImportFileTableInfo[] = [];
  for (const [name, rows] of Object.entries(tables)) {
    out.push({
      name,
      rows: rows.length,
      exists_in_db: await tableExists(db, name),
      columns: columnsOfJsonRows(rows),
    });
  }
  return {
    file_name: fileName,
    file_type: "json",
    file_size: Buffer.byteLength(text),
    driver: driverOf(db),
    supported: true,
    unsupported_reason: "",
    tables: out,
  };
}

/** node:sqlite 惰性加载（仅本地 Node 分支触达；Edge/D1 不允许出现静态 node: 引用）。 */
async function nodeSqlite(): Promise<typeof import("node:sqlite")> {
  const loader = new Function(`return import("node:sqlite")`) as () => Promise<typeof import("node:sqlite")>;
  return loader();
}

interface SourceDb {
  tables: ImportFileTableInfo[];
  columnsOf(table: string): string[];
  readRows(table: string, columns: string[]): Promise<SqlRow[]>;
  close(): void;
}

async function openSourceDb(bytes: Uint8Array): Promise<SourceDb> {
  const [{ DatabaseSync }, os, fs, path] = await Promise.all([
    nodeSqlite(),
    import("node:os"),
    import("node:fs"),
    import("node:path"),
  ]);
  const tmp = path.join(os.tmpdir(), `tgbots-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  fs.writeFileSync(tmp, bytes);
  let src: InstanceType<typeof DatabaseSync>;
  try {
    src = new DatabaseSync(tmp, { readOnly: true });
  } catch (error) {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    throw new Error(
      `无法作为 SQLite 数据库打开（文件损坏或不是 .db 文件）: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const tableRows = src
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string; sql: string | null }[];
  const tables: ImportFileTableInfo[] = tableRows.map((t) => ({
    name: t.name,
    rows: Number((src.prepare(`SELECT COUNT(*) as c FROM "${t.name}"`).get() as { c: number }).c),
    exists_in_db: false,
    create_sql: t.sql ?? undefined,
  }));
  const columnsCache = new Map<string, string[]>();
  return {
    tables,
    columnsOf(table) {
      let cols = columnsCache.get(table);
      if (!cols) {
        cols = (src.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name);
        columnsCache.set(table, cols);
      }
      return cols;
    },
    async readRows(table, columns) {
      const cols = columns.map((c) => `"${c}"`).join(", ");
      const rows = src.prepare(`SELECT ${cols} FROM "${table}"`).all() as SqlRow[];
      return rows;
    },
    close() {
      try {
        src.close();
      } catch {
        // 关闭失败不阻断主流程
      }
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    },
  };
}

/**
 * 解析上传文件 → 导入分析（表清单 / 行数 / 本地存在性 / 运行环境支持判定）。
 * .db 在 D1 运行环境直接判不支持（Workers 无 SQLite 引擎），不做无谓解析。
 */
export async function analyzeImportFile(db: SqlDatabase, fileName: string, bytes: Uint8Array): Promise<ImportAnalysis> {
  const fileType = importFileTypeOf(fileName);
  if (!fileType) {
    throw new Error("仅支持 .sql / .db / .json 三种备份文件格式");
  }
  const driver = driverOf(db);
  if (fileType === "db" && db.kind !== "node") {
    return {
      file_name: fileName,
      file_type: fileType,
      file_size: bytes.byteLength,
      driver,
      supported: false,
      unsupported_reason:
        ".db 为 SQLite 二进制快照，需要本地 SQLite 引擎解析；当前运行环境为 Cloudflare D1，无法直接导入。请改用 .sql 或 .json 格式（两者在 D1 下均可完整导入覆盖）。",
      tables: [],
    };
  }
  if (fileType === "sql" || fileType === "json") {
    const text = Buffer.from(bytes).toString("utf-8");
    return fileType === "sql" ? analyzeSql(db, fileName, text) : analyzeJson(db, fileName, text);
  }
  // .db（仅 node 驱动会走到这里）
  const src = await openSourceDb(bytes);
  try {
    const tables: ImportFileTableInfo[] = [];
    for (const t of src.tables) {
      tables.push({ ...t, exists_in_db: await tableExists(db, t.name) });
    }
    return {
      file_name: fileName,
      file_type: "db",
      file_size: bytes.byteLength,
      driver,
      supported: true,
      unsupported_reason: "",
      tables,
    };
  } finally {
    src.close();
  }
}

// ---------------------------------------------------------------------------
// apply（整表覆盖）
// ---------------------------------------------------------------------------

function normalizeValue(v: unknown): string | number | bigint | Uint8Array | null {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === "string" || t === "number" || t === "bigint") return v as string | number | bigint;
  if (t === "boolean") return v ? 1 : 0;
  if (v instanceof Uint8Array) return v;
  return JSON.stringify(v);
}

/** 本地表缺列时自动补齐（无类型声明 = BLOB 亲和，值按原类型保真，与导入数据零损耗）。 */
async function ensureColumns(db: SqlDatabase, table: string, fileColumns: string[]): Promise<string[]> {
  if (!validIdent(table)) throw new Error(`非法表名: ${table}`);
  const existing = await dbColumnsOf(db, table);
  if (!existing.length) throw new Error(`本地库中不存在表 ${table}`);
  const added: string[] = [];
  for (const col of fileColumns) {
    if (!validIdent(col)) continue;
    if (existing.includes(col)) continue;
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`);
    added.push(col);
  }
  return added;
}

async function insertRows(db: SqlDatabase, table: string, columns: string[], rows: SqlRow[]): Promise<number> {
  const cols = columns.filter(validIdent);
  if (!cols.length) return 0;
  const placeholders = cols.map(() => "?").join(", ");
  const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`;
  let inserted = 0;
  for (const row of rows) {
    const vals = cols.map((c) => normalizeValue((row as SqlRow)[c]));
    await db.run(sql, vals);
    inserted += 1;
  }
  return inserted;
}

async function deleteTable(db: SqlDatabase, table: string): Promise<number> {
  const before = await db.all<{ c: number }>(`SELECT COUNT(*) as c FROM ${table}`);
  await db.run(`DELETE FROM ${table}`);
  return Number(before[0]?.c || 0);
}

/** D1 语句分块（避免单次 exec 过大）。 */
function chunkStatements(statements: string[], maxChars = 96 * 1024): string[][] {
  const chunks: string[][] = [];
  let cur: string[] = [];
  let size = 0;
  for (const st of statements) {
    if (cur.length && size + st.length > maxChars) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(st);
    size += st.length;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

async function applySql(
  db: SqlDatabase,
  analysis: ImportAnalysis,
  text: string,
  selected: string[],
  report: ImportReport,
): Promise<void> {
  const statements = splitSqlStatements(text);
  // 按表分组（保持文件内顺序：先 DELETE 后 INSERT）
  const byTable = new Map<string, string[]>();
  for (const st of statements) {
    const upper = st.toUpperCase();
    let table = "";
    if (upper.startsWith("INSERT INTO")) table = tableNameOf(st, "INSERT");
    else if (upper.startsWith("DELETE FROM")) table = tableNameOf(st, "DELETE");
    else if (upper.startsWith("CREATE TABLE")) table = tableNameOf(st, "CREATE");
    if (!table) continue;
    let list = byTable.get(table);
    if (!list) {
      list = [];
      byTable.set(table, list);
    }
    list.push(st);
  }
  const fileTables = new Map(analysis.tables.map((t) => [t.name, t]));
  for (const table of selected) {
    const meta = fileTables.get(table);
    const statementsOfTable = byTable.get(table) ?? [];
    try {
      let created = false;
      if (!(await tableExists(db, table))) {
        const createSql = meta?.create_sql ?? statementsOfTable.find((s) => s.toUpperCase().startsWith("CREATE TABLE"));
        if (!createSql) {
          report[table] = { deleted: 0, imported: 0, created: false, added_columns: [], error: "本地库中不存在该表且文件未提供建表语句" };
          continue;
        }
        await db.exec(createSql);
        created = true;
      }
      const addedColumns = meta?.columns?.length ? await ensureColumns(db, table, meta.columns) : [];
      const deletes = statementsOfTable.filter((s) => s.toUpperCase().startsWith("DELETE FROM"));
      const inserts = statementsOfTable.filter((s) => s.toUpperCase().startsWith("INSERT INTO"));
      const beforeRows = await db.all<{ c: number }>(`SELECT COUNT(*) as c FROM ${table}`);
      for (const st of deletes) await db.exec(st);
      const deleted = Number(beforeRows[0]?.c || 0);
      let imported = 0;
      for (const st of inserts) {
        await db.exec(st);
        imported += 1;
      }
      report[table] = { deleted, imported, created, added_columns: addedColumns, error: "" };
    } catch (error) {
      report[table] = {
        deleted: 0,
        imported: 0,
        created: false,
        added_columns: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

async function applyJson(
  db: SqlDatabase,
  text: string,
  selected: string[],
  report: ImportReport,
): Promise<void> {
  const tables = jsonTablesOf(text);
  for (const table of selected) {
    const rows = tables[table];
    if (!rows) {
      report[table] = { deleted: 0, imported: 0, created: false, added_columns: [], error: "文件中不存在该表" };
      continue;
    }
    try {
      let created = false;
      if (!(await tableExists(db, table))) {
        report[table] = { deleted: 0, imported: 0, created: false, added_columns: [], error: "本地库中不存在该表且 .json 备份不含建表语句" };
        continue;
      }
      const columns = columnsOfJsonRows(rows);
      const addedColumns = await ensureColumns(db, table, columns);
      const deleted = await deleteTable(db, table);
      const imported = await insertRows(db, table, columns, rows as SqlRow[]);
      report[table] = { deleted, imported, created, added_columns: addedColumns, error: "" };
    } catch (error) {
      report[table] = {
        deleted: 0,
        imported: 0,
        created: false,
        added_columns: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

async function applyDb(
  db: SqlDatabase,
  bytes: Uint8Array,
  selected: string[],
  report: ImportReport,
): Promise<void> {
  const src = await openSourceDb(bytes);
  try {
    const srcTables = new Map(src.tables.map((t) => [t.name, t]));
    for (const table of selected) {
      const meta = srcTables.get(table);
      if (!meta) {
        report[table] = { deleted: 0, imported: 0, created: false, added_columns: [], error: "文件中不存在该表" };
        continue;
      }
      try {
        let created = false;
        if (!(await tableExists(db, table))) {
          if (!meta.create_sql) {
            report[table] = { deleted: 0, imported: 0, created: false, added_columns: [], error: "本地库中不存在该表且源库未提供建表语句" };
            continue;
          }
          await db.exec(meta.create_sql);
          created = true;
        }
        // 以源库列为准读取行；目标库缺列先补齐（保真导入），目标多出的列保持 NULL/默认
        const srcColumns = src.columnsOf(table);
        const addedColumns = await ensureColumns(db, table, srcColumns);
        const deleted = created ? 0 : await deleteTable(db, table);
        const rows = await src.readRows(table, srcColumns);
        const imported = await insertRows(db, table, srcColumns, rows);
        report[table] = { deleted, imported, created, added_columns: addedColumns, error: "" };
      } catch (error) {
        report[table] = {
          deleted: 0,
          imported: 0,
          created: false,
          added_columns: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  } finally {
    src.close();
  }
}

/**
 * 按选中表「整表覆盖」导入。
 * Node 驱动整体 BEGIN/COMMIT（任一表失败全量回滚）；D1 无跨语句事务，逐表执行并如实上报失败。
 */
export async function applyImportFile(
  db: SqlDatabase,
  fileName: string,
  bytes: Uint8Array,
  selected: string[],
): Promise<ImportReport> {
  const fileType = importFileTypeOf(fileName);
  if (!fileType) throw new Error("仅支持 .sql / .db / .json 三种备份文件格式");
  if (!selected.length) throw new Error("未选择任何要导入的表");
  for (const t of selected) {
    if (!validIdent(t)) throw new Error(`非法表名: ${t}`);
  }
  const driver = driverOf(db);
  if (fileType === "db" && db.kind !== "node") {
    throw new Error(".db 二进制仅支持本地 SQLite 驱动导入（当前驱动: " + driver + "）— 请改用 .sql 或 .json");
  }
  const report: ImportReport = {};
  // Node 驱动整体事务（任一表失败全量回滚）；D1 无跨语句事务，逐表执行并如实上报失败
  const useTransaction = db.kind === "node";
  if (useTransaction) await db.exec("BEGIN");
  try {
    if (fileType === "sql") {
      const text = Buffer.from(bytes).toString("utf-8");
      const analysis = await analyzeImportFile(db, fileName, bytes);
      await applySql(db, analysis, text, selected, report);
    } else if (fileType === "json") {
      const text = Buffer.from(bytes).toString("utf-8");
      await applyJson(db, text, selected, report);
    } else {
      await applyDb(db, bytes, selected, report);
    }
    if (useTransaction) await db.exec("COMMIT");
  } catch (error) {
    if (useTransaction) await db.exec("ROLLBACK").catch(() => {});
    throw error;
  }
  return report;
}
