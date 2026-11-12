/**
 * backup-restore — 备份导入（v2.2.3，自 xianyu-admin v2.3.10 backup-restore.ts 原样复刻，
 * 数据层适配本项目 SqlDatabase：get 由 all 首行实现，事务用 exec BEGIN/COMMIT 包裹）。
 *
 * 手动导入 (/api/admin/backup/import) 与备份列表「导入」(R2/本地快照对象回灌)
 * 共用同一套按表主键 upsert 语义, 绝不做第二套解析。
 * v2.3.0：表范围与主键改为运行时表目录自动枚举（loadTableCatalog），
 * 库中不存在的表跳过；无显式主键表走 INSERT OR REPLACE 整行覆盖。
 */

import type { SqlDatabase } from "@/database/client";
import { isCatalogTable, loadTableCatalog, pkOfTable } from "./whitelist";

export type RestoreReport = Record<string, { inserted: number; updated: number; skipped: number }>;

/** 导入一个 tables 对象（按表主键 upsert; 库中不存在的表跳过; 复合主键/无主键表走 INSERT OR REPLACE 全量覆盖）。 */
export async function restoreTables(
  db: SqlDatabase,
  incoming: Record<string, Record<string, unknown>[]>,
): Promise<RestoreReport> {
  if (!incoming || typeof incoming !== "object") {
    throw new Error("备份格式错误：缺少 tables 对象");
  }
  const catalog = await loadTableCatalog(db);
  const report: RestoreReport = {};
  await db.exec("BEGIN");
  try {
    for (const [table, rows] of Object.entries(incoming)) {
      if (!isCatalogTable(catalog, table)) continue;
      if (!Array.isArray(rows)) continue;
      let inserted = 0;
      let updated = 0;
      let skipped = 0;
      const pk = pkOfTable(catalog, table);
      const compoundPk = pk === null || Array.isArray(pk);
      for (const row of rows) {
        if (!row || typeof row !== "object") {
          skipped += 1;
          continue;
        }
        const cols = Object.keys(row);
        if (!cols.length) {
          skipped += 1;
          continue;
        }
        if (compoundPk) {
          // 复合主键表（如 role_permissions）/无显式主键表：整行 INSERT OR REPLACE 全量覆盖语义
          const placeholders = cols.map(() => "?").join(", ");
          const vals = cols.map((c) => row[c] as string | number | null);
          try {
            await db.run(
              `INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`,
              vals,
            );
            inserted += 1;
          } catch (error) {
            skipped += 1;
            console.error(`备份导入 ${table} INSERT OR REPLACE 失败（该行跳过）:`, error);
          }
          continue;
        }
        // 单列主键：PK 在行中 → 已存在则 UPDATE, 否则 INSERT（与 xianyu upsert 语义一致）
        if (row[pk] !== undefined && row[pk] !== null) {
          const existing = await db.all(`SELECT ${pk} FROM ${table} WHERE ${pk} = ?`, [row[pk] as string | number]);
          if (existing.length > 0) {
            const setClause = cols.filter((c) => c !== pk).map((c) => `${c} = ?`).join(", ");
            const setVals = cols.filter((c) => c !== pk).map((c) => row[c] as string | number | null);
            if (setClause) {
              await db.run(`UPDATE ${table} SET ${setClause} WHERE ${pk} = ?`, [...setVals, row[pk] as string | number]);
              updated += 1;
            } else {
              skipped += 1;
            }
            continue;
          }
        }
        const placeholders = cols.map(() => "?").join(", ");
        const vals = cols.map((c) => row[c] as string | number | null);
        try {
          await db.run(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`, vals);
          inserted += 1;
        } catch (error) {
          skipped += 1;
          console.error(`备份导入 ${table} INSERT 失败（该行跳过）:`, error);
        }
      }
      report[table] = { inserted, updated, skipped };
    }
    await db.exec("COMMIT");
  } catch (error) {
    await db.exec("ROLLBACK").catch((rollbackError: unknown) => {
      console.error("备份导入 ROLLBACK 失败（连接可能残留打开事务）:", rollbackError);
    });
    throw error;
  }
  return report;
}
