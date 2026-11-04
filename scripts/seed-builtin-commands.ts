/**
 * v1.1.0 增量种子：把 23 条官方内置指令（含详细中文介绍与默认排序）upsert 到现有数据库。
 * 幂等可重复执行；自定义指令不受影响。
 * 运行：bun run seed:commands
 */
import { executeRun, getDatabase, queryOne } from "@/database/client";
import { loadDotEnv } from "@/lib/dotenv";
import { BUILTIN_COMMANDS } from "./db-init";

loadDotEnv();

async function main(): Promise<void> {
  for (const cmd of BUILTIN_COMMANDS) {
    await executeRun(
      `INSERT INTO bot_commands (type, name, description, intro, enabled, sort_order, created_time, updated_time)
       VALUES ('builtin', ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(type, name) DO UPDATE SET
         description = excluded.description,
         intro = excluded.intro,
         sort_order = excluded.sort_order,
         enabled = 1,
         updated_time = excluded.updated_time`,
      [cmd.name, cmd.description, cmd.intro, cmd.sort, new Date().toISOString(), new Date().toISOString()],
    );
  }
  const row = await queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM bot_commands WHERE type = 'builtin'`);
  const info = await getDatabase();
  console.log(
    `Builtin commands upserted: ${BUILTIN_COMMANDS.length} (table total: ${Number(row?.total ?? 0)}) at ${info.displayPath}`,
  );
}

main().catch((error) => {
  console.error("Builtin command seed failed:", error);
  process.exitCode = 1;
});
