/**
 * backup-restore — 备份导入（v2.2.3，自 xianyu-admin v2.3.10 backup-restore.ts 原样复刻，
 * 数据层适配本项目 SqlDatabase：get 由 all 首行实现，事务用 exec BEGIN/COMMIT 包裹）。
 *
 * 手动导入 (/api/admin/backup/import) 与备份列表「导入」(R2/本地快照对象回灌)
 * 共用同一套按表 PK upsert 语义, 绝不做第二套解析。
 */
import type { SqlDatabase } from "@/database/client";
import { isWhitelistedTable, pkOf } from "./whitelist";

export type RestoreReport = Record<string, { inserted: number; updated: number; skipped: number }>;

function isCompoundPk(pk: string | string[]): pk is string[] {
  return Array.isArray(pk);
}

/** 导入一个 tables 对象（按表 PK upsert; 非白名单表跳过; 复合主键表走 INSERT OR REPLACE）。 */
export async function restoreTables(
  db: SqlDatabase,
  incoming: Record<string, Record<string, unknown>[]>,
): Promise<RestoreReport> {
  if (!incoming || typeof incoming !== "object") {
    throw new Error("备份格式错误：缺少 tables 对象");
  }
  const report: RestoreReport = {};
  await db.exec("BEGIN");
  try {
    for (const [table, rows] of Object.entries(incoming)) {
      if (!isWhitelistedTable(table)) continue;
      if (!Array.isArray(rows)) continue;
      let inserted = 0;
      let updated = 0;
      let skipped = 0;
      const pk = pkOf(table);
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
        if (isCompoundPk(pk)) {
          // 复合主键表（如 role_permissions）：整行 INSERT OR REPLACE 全量覆盖语义
          const placeholders = cols.map(() => "?").join(", ");
          const vals = cols.map((c) => row[c] as string | number | null);
          try {
            await db.run(
              `INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`,
              vals,
            );
            inserted += 1;
          } catch {
            skipped += 1;
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
        } catch {
          skipped += 1;
        }
      }
      report[table] = { inserted, updated, skipped };
    }
    await db.exec("COMMIT");
  } catch (error) {
    await db.exec("ROLLBACK").catch(() => {});
    throw error;
  }
  return report;
}
