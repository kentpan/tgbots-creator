/**
 * 备份表目录（v2.3.0）：运行时自动枚举主库全部业务表并解析主键 ——
 * SQLite 与 Cloudflare D1 同源（sqlite_master + PRAGMA table_info 两条驱动通用）。
 * 新增表零维护自动进入导出 / 定时备份 / 导入回灌范围，不再维护手工表清单。
 *
 * 排除：admin_sessions（管理员登录会话，运行时态，备份回灌无意义）、
 * sqlite_ 与 _cf_ 前缀的数据库系统内部表。
 */

import type { SqlDatabase } from "@/database/client";

/** 备份排除的运行时态表 */
const EXCLUDED_TABLES = new Set(["admin_sessions"]);

/** 系统内部表前缀（sqlite_master 结果过滤；_cf_ 为 D1 内部表） */
const INTERNAL_TABLE_PREFIXES = ["sqlite_", "_cf_"];

export interface TableCatalog {
  /** 业务表名（按名称升序） */
  tables: string[];
  /** 表主键：单列主键为列名，复合主键为列名数组；无显式主键的表不设键 */
  pks: Record<string, string | string[]>;
}

/** 引用 SQL 标识符（表名来自 sqlite_master，双引号包裹防保留字/特殊字符） */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * 枚举主库全部业务表并解析主键。每次调用实时查询（表数量级为几十，开销可忽略），
 * 新增/删表立即生效，绝不缓存目录。
 */
export async function loadTableCatalog(db: SqlDatabase): Promise<TableCatalog> {
  const rows = await db.all<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
  );
  const tables = rows
    .map((row) => row.name)
    .filter(
      (name) =>
        typeof name === "string" &&
        !EXCLUDED_TABLES.has(name) &&
        !INTERNAL_TABLE_PREFIXES.some((prefix) => name.startsWith(prefix)),
    );
  const pks: Record<string, string | string[]> = {};
  for (const table of tables) {
    const info = await db.all<{ name: string; pk: number }>(
      `PRAGMA table_info(${quoteIdent(table)})`,
    );
    // pk 列标记从 1 开始，复合主键按声明顺序 1,2,3…
    const pkCols = info
      .filter((col) => Number(col.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map((col) => col.name);
    if (pkCols.length === 1) pks[table] = pkCols[0];
    else if (pkCols.length > 1) pks[table] = pkCols;
  }
  return { tables, pks };
}

/** 表是否存在于当前数据库（导出/定时备份/导入的表名合法性判定） */
export function isCatalogTable(catalog: TableCatalog, name: string): boolean {
  return catalog.tables.includes(name);
}

/**
 * 表主键（单列返回列名，复合返回列名数组）。
 * 无显式主键返回 null —— 导入回灌对该表走 INSERT OR REPLACE 整行覆盖语义。
 */
export function pkOfTable(catalog: TableCatalog, name: string): string | string[] | null {
  return Object.prototype.hasOwnProperty.call(catalog.pks, name)
    ? (catalog.pks[name] ?? null)
    : null;
}
