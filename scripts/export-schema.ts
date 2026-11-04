import { getDatabase, queryAll } from "@/database/client";
import { loadDotEnv } from "@/lib/dotenv";

loadDotEnv();

async function main(): Promise<void> {
  const lines: string[] = [];
  lines.push("-- TGuard (bot-groups) SQLite schema export");
  lines.push("-- Compatible with node:sqlite (Node runtime) and Cloudflare D1 (Workers runtime)");
  lines.push("PRAGMA foreign_keys = OFF;");
  lines.push("BEGIN TRANSACTION;");

  const tables = await queryAll<{ name: string; sql: string }>(
    `SELECT name, sql FROM sqlite_master
     WHERE type = 'table' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
     ORDER BY rootpage`,
  );
  for (const table of tables) {
    lines.push(`${table.sql};`);
  }

  const indexes = await queryAll<{ name: string; sql: string }>(
    `SELECT name, sql FROM sqlite_master
     WHERE type = 'index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_autoindex%'
     ORDER BY name`,
  );
  for (const index of indexes) {
    lines.push(`${index.sql};`);
  }

  lines.push("COMMIT;");
  console.log(lines.join("\n"));
}

main().catch((error) => {
  console.error("Schema export failed:", error);
  process.exitCode = 1;
});
