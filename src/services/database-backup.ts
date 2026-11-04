import { queryAll } from "@/database/client";
import { getStorage } from "@/database/bindings";

function escapeSqlValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (value instanceof Uint8Array) return "NULL";
  const text = String(value);
  return `'${text.replaceAll("'", "''")}'`;
}

export async function dumpDatabaseSql(): Promise<string> {
  const lines: string[] = [];
  lines.push("-- TGuard (bot-groups) full database dump");
  lines.push("BEGIN TRANSACTION;");

  const tables = await queryAll<{ name: string }>(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'
     ORDER BY name`,
  );

  for (const table of tables) {
    const columns = await queryAll<{ name: string }>(`PRAGMA table_info(${table.name})`);
    if (columns.length === 0) continue;
    const rows = await queryAll<Record<string, unknown>>(
      `SELECT * FROM ${table.name}`,
    );
    if (rows.length === 0) continue;
    const columnList = columns.map((column) => column.name).join(", ");
    for (const row of rows) {
      const values = columns.map((column) => escapeSqlValue(row[column.name])).join(", ");
      lines.push(`INSERT INTO ${table.name} (${columnList}) VALUES (${values});`);
    }
  }

  lines.push("COMMIT;");
  return lines.join("\n");
}

export async function createDatabaseBackup(): Promise<{ key: string; size: number }> {
  const sql = await dumpDatabaseSql();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const key = `backups/bot-groups-${stamp}.sql`;
  const data = new TextEncoder().encode(sql);
  await getStorage().put(key, data, "application/sql");
  return { key, size: data.byteLength };
}

export async function listDatabaseBackups(): Promise<{ key: string; size: number }[]> {
  const storage = getStorage();
  const keys = await storage.list("backups");
  const result: { key: string; size: number }[] = [];
  for (const key of keys) {
    const data = await storage.get(key);
    result.push({ key, size: data ? data.byteLength : 0 });
  }
  return result.sort((a, b) => b.key.localeCompare(a.key)).slice(0, 10);
}
