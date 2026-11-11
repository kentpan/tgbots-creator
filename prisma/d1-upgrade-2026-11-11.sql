-- tgbots-creator v2.2.8 — 线上 D1 schema 应急补齐（一次性执行，可重复执行的语句已带 IF NOT EXISTS）
-- 背景: 线上 D1 为老版本结构(bot_commands 缺 bot_id/group_id, 缺 admin_sessions/api_logs 表)
-- 根因: .gitignore 曾忽略 prisma/*.db 与 prisma/*.sql → CI 走 schema-only 链路(IF NOT EXISTS 对已存在表零作用)
-- 用法: Cloudflare 控制台 D1 → 选库 → Console 逐条执行; ALTER 语句仅执行一次(重复报 duplicate column 可忽略)
-- 正式修复: 部署 v2.2.8(CI Migrate 链路自动求差补列, 数据不动)

-- ===== 新建表 admin_sessions (线上缺失) =====
CREATE TABLE IF NOT EXISTS "admin_sessions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" DATETIME NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- ===== 新建表 api_logs (线上缺失) =====
CREATE TABLE IF NOT EXISTS "api_logs" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "category" TEXT NOT NULL,
        "bot_id" TEXT,
        "bot_label" TEXT,
        "method" TEXT NOT NULL DEFAULT '',
        "ok" INTEGER NOT NULL DEFAULT 1,
        "status_code" INTEGER,
        "request_payload" TEXT,
        "response_body" TEXT,
        "error" TEXT,
        "duration_ms" INTEGER,
        "created_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

-- ===== bot_commands 补列 (线上缺 bot_id/group_id — 图1部署报错/图3指令菜单500 的直接根因) =====
ALTER TABLE "bot_commands" ADD COLUMN bot_id INTEGER;
ALTER TABLE "bot_commands" ADD COLUMN group_id INTEGER;
