import { executeRun, getDatabase, queryAll, queryOne, type SqlRow } from "@/database/client";
import { loadDotEnv, getEnvBaseDir } from "@/lib/dotenv";
import path from "node:path";

loadDotEnv();

async function db_one<T extends SqlRow>(sql: string, params: (string | number)[] = []): Promise<T | null> {
  return queryOne<T>(sql, params);
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const cols = await queryAll<{ name: string }>(`PRAGMA table_info(${table})`);
  return cols.some((c) => c.name === column);
}

/**
 * v1.0.7 迁移（幂等）：
 * 1. group_settings 增加 privacy_mode 列（加群验证隐私模式开关，默认开启）
 * 2. 新增 bot_commands 指令库表（内置指令 + 自定义指令）
 * 3. 内置官方指令种子数据（含中文介绍）
 * 4. 菜单：机器人管理下新增「指令管理」子菜单
 */
async function main(): Promise<void> {
  // 1. group_settings.privacy_mode
  if (!(await columnExists("group_settings", "privacy_mode"))) {
    await executeRun(
      `ALTER TABLE "group_settings" ADD COLUMN "privacy_mode" BOOLEAN NOT NULL DEFAULT true`,
    );
    console.log("✓ group_settings.privacy_mode 列已添加");
  } else {
    console.log("- group_settings.privacy_mode 已存在，跳过");
  }

  // 2. bot_commands 表
  await executeRun(
    `CREATE TABLE IF NOT EXISTS "bot_commands" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "type" TEXT NOT NULL DEFAULT 'builtin',
      "name" TEXT NOT NULL,
      "description" TEXT NOT NULL DEFAULT '',
      "intro" TEXT NOT NULL DEFAULT '',
      "enabled" BOOLEAN NOT NULL DEFAULT true,
      "sort_order" INTEGER NOT NULL DEFAULT 0,
      "created_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  );
  await executeRun(
    `CREATE UNIQUE INDEX IF NOT EXISTS "bot_commands_type_name_key" ON "bot_commands"("type", "name")`,
  );
  console.log("✓ bot_commands 表已就绪");

  // 3. 内置官方指令种子（type/name 唯一，重复跳过）
  const BUILTIN_COMMANDS: {
    name: string;
    description: string;
    intro: string;
    sort: number;
  }[] = [
    {
      name: "start",
      description: "启动机器人",
      intro:
        "Telegram 官方标准入口指令。用户首次与机器人对话时自动触发，发送欢迎语并展示主菜单按钮。每个机器人必须提供 /start 指令，否则用户无法开始会话。",
      sort: 1,
    },
    {
      name: "help",
      description: "显示帮助信息",
      intro:
        "展示机器人的使用说明与技术支持入口。TGuard 中该指令回复项目 README 链接与使用指引，帮助用户快速了解验证机器人的功能。",
      sort: 2,
    },
    {
      name: "stats",
      description: "查看验证统计",
      intro:
        "仅管理员可用。回复当前机器人的验证总请求数、通过数、拒绝数、待处理数、过期数、通过率以及今日统计。数据来自数据库实时聚合。",
      sort: 3,
    },
    {
      name: "api",
      description: "查看外部 API 状态",
      intro:
        "仅管理员可用。在私聊中回复外部 API 的启用状态、服务器地址与 API Key（自动规避群聊泄露风险）。用于对接外部系统的运维排查。",
      sort: 4,
    },
  ];
  for (const cmd of BUILTIN_COMMANDS) {
    const existing = await db_one(
      `SELECT id FROM bot_commands WHERE type = 'builtin' AND name = ?`,
      [cmd.name],
    );
    if (existing) continue;
    await executeRun(
      `INSERT INTO bot_commands (type, name, description, intro, enabled, sort_order, created_time, updated_time)
       VALUES ('builtin', ?, ?, ?, 1, ?, ?, ?)`,
      [cmd.name, cmd.description, cmd.intro, cmd.sort, new Date().toISOString(), new Date().toISOString()],
    );
  }
  console.log(`✓ 内置指令种子就绪（${BUILTIN_COMMANDS.length} 条）`);

  // 4. 菜单：机器人管理下新增「指令管理」
  const botsRoot = await db_one(
    `SELECT id FROM menus WHERE path = '/admin/bots' AND parent_id = 0`,
  );
  if (botsRoot) {
    const existing = await db_one(
      `SELECT id FROM menus WHERE path = '/admin/bots/commands' AND parent_id = ?`,
      [Number(botsRoot.id)],
    );
    if (!existing) {
      await executeRun(
        `INSERT INTO menus (parent_id, title, path, icon, sort_order, visible, permission_code, status, created_time, updated_time)
         VALUES (?, '指令管理', '/admin/bots/commands', '⌨️', 3, 1, 'bots:view', 1, ?, ?)`,
        [Number(botsRoot.id), new Date().toISOString(), new Date().toISOString()],
      );
      console.log("✓ 菜单「指令管理」已添加（机器人 → 指令管理）");
    } else {
      console.log("- 菜单「指令管理」已存在，跳过");
    }
  } else {
    console.log("! 未找到「机器人管理」根菜单，跳过指令管理菜单插入（db-init 会处理）");
  }

  const info = await getDatabase();
  console.log(`迁移完成：${info.displayPath} (${info.kind})`);
  console.log(`数据库目录：${path.resolve(getEnvBaseDir())}`);
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exitCode = 1;
});
