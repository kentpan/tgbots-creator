import { readFileSync } from "node:fs";
import path from "node:path";
import {
  executeRun,
  getDatabase,
  queryAll,
  queryOne,
  type SqlParam,
  type SqlRow,
} from "@/database/client";
import { loadDotEnv, getEnvBaseDir } from "@/lib/dotenv";
import { hashPassword } from "@/lib/password";

loadDotEnv();

const PERMISSIONS: { code: string; name: string; description: string; sort: number }[] = [
  { code: "dashboard:view", name: "查看控制台", description: "访问管理后台控制台", sort: 1 },
  { code: "requests:view", name: "查看加群申请", description: "浏览加群申请记录", sort: 2 },
  { code: "requests:manage", name: "处理加群申请", description: "手动批准或拒绝加群申请", sort: 3 },
  { code: "groups:view", name: "查看群组配置", description: "浏览群组验证配置", sort: 4 },
  { code: "groups:manage", name: "管理群组配置", description: "编辑群组验证配置", sort: 5 },
  { code: "methods:view", name: "查看验证方式", description: "浏览自定义验证方式", sort: 6 },
  { code: "methods:manage", name: "管理验证方式", description: "创建编辑删除自定义验证方式", sort: 7 },
  { code: "users:view", name: "查看系统用户", description: "浏览后台管理用户", sort: 8 },
  { code: "users:manage", name: "管理系统用户", description: "创建编辑停用后台用户", sort: 9 },
  { code: "roles:view", name: "查看角色权限", description: "浏览角色与权限分配", sort: 10 },
  { code: "roles:manage", name: "管理角色权限", description: "创建编辑角色并分配权限", sort: 11 },
  { code: "menus:view", name: "查看菜单", description: "浏览后台菜单配置", sort: 12 },
  { code: "menus:manage", name: "管理菜单", description: "创建编辑删除后台菜单", sort: 13 },
  { code: "settings:view", name: "查看系统设置", description: "浏览系统运行参数", sort: 14 },
  { code: "settings:manage", name: "管理系统设置", description: "修改系统运行参数", sort: 15 },
  { code: "logs:view", name: "查看操作日志", description: "查看后台操作审计日志", sort: 16 },
  { code: "bots:view", name: "查看机器人", description: "浏览机器人列表与交互菜单配置", sort: 17 },
  { code: "bots:manage", name: "管理机器人", description: "创建编辑机器人并同步交互菜单", sort: 18 },
  { code: "devaccounts:view", name: "查看开发者账号", description: "浏览 Telegram 开发者账号", sort: 19 },
  { code: "devaccounts:manage", name: "管理开发者账号", description: "维护手机号与 api_id/api_hash", sort: 20 },
  { code: "ai:view", name: "查看AI配置", description: "浏览 AI 模型配置与调用统计", sort: 21 },
  { code: "ai:manage", name: "管理AI配置", description: "创建编辑删除 AI 模型并设置默认模型", sort: 22 },
  { code: "tgapi:view", name: "查看TGAPI申请", description: "浏览 TGAPI 申请机器人与解锁用户", sort: 23 },
  { code: "tgapi:manage", name: "管理TGAPI申请", description: "创建编辑 TGAPI 申请机器人与解锁配置", sort: 24 },
];

const OPERATOR_PERMISSION_CODES = [
  "dashboard:view",
  "requests:view",
  "requests:manage",
  "groups:view",
  "groups:manage",
  "methods:view",
  "methods:manage",
  "bots:view",
  "devaccounts:view",
  "tgapi:view",
  "logs:view",
];

const MENUS: {
  title: string;
  path: string;
  icon: string;
  sort: number;
  permission: string;
  children?: { title: string; path: string; icon: string; sort: number; permission: string }[];
}[] = [
  { title: "控制台", path: "/admin", icon: "📊", sort: 1, permission: "dashboard:view" },
  { title: "加群申请", path: "/admin/join-requests", icon: "📋", sort: 2, permission: "requests:view" },
  { title: "群组管理", path: "/admin/groups", icon: "🏷️", sort: 3, permission: "groups:view" },
  {
    title: "机器人",
    path: "",
    icon: "🤖",
    sort: 4,
    permission: "bots:view",
    children: [
      { title: "机器人管理", path: "/admin/bots", icon: "🤖", sort: 1, permission: "bots:view" },
      { title: "机器人测试", path: "/admin/bots/testing", icon: "🧪", sort: 2, permission: "bots:view" },
      { title: "指令管理", path: "/admin/bots/commands", icon: "⌨️", sort: 3, permission: "bots:view" },
      { title: "开发者账号", path: "/admin/developer-accounts", icon: "☎️", sort: 4, permission: "devaccounts:view" },
      { title: "TGAPI申请", path: "/admin/tgapi", icon: "🔑", sort: 5, permission: "tgapi:view" },
    ],
  },
  { title: "验证方式", path: "/admin/verification-methods", icon: "🔐", sort: 5, permission: "methods:view" },
  { title: "系统用户", path: "/admin/users", icon: "👤", sort: 6, permission: "users:view" },
  { title: "角色权限", path: "/admin/roles", icon: "🛡️", sort: 7, permission: "roles:view" },
  { title: "菜单管理", path: "/admin/menus", icon: "🧭", sort: 8, permission: "menus:view" },
  { title: "系统设置", path: "/admin/settings", icon: "⚙️", sort: 9, permission: "settings:view" },
  { title: "AI 配置", path: "/admin/ai", icon: "🧠", sort: 10, permission: "ai:view" },
  { title: "操作日志", path: "/admin/logs", icon: "📜", sort: 11, permission: "logs:view" },
];

async function ensureMigrations(): Promise<void> {
  await executeRun(
    `CREATE TABLE IF NOT EXISTS "bots" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "name" TEXT NOT NULL,
      "token" TEXT NOT NULL,
      "username" TEXT,
      "enabled" BOOLEAN NOT NULL DEFAULT true,
      "config" TEXT NOT NULL DEFAULT '{}',
      "menu_config" TEXT NOT NULL DEFAULT '{}',
      "menu_text" TEXT NOT NULL DEFAULT '📋 请使用下方菜单：',
      "created_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  );
  await executeRun(
    // v1.0.8：Token 允许重复（同一 Bot Token 可建多个管理条目，如「交付机器人」与「加群验证机器人」），
    // 同 Token 仅保留一个轮询实例（见 multi-runtime 的 runningTokens 去重）。
    `CREATE INDEX IF NOT EXISTS "idx_bots_token" ON "bots"("token")`,
  );
  await executeRun(
    `CREATE TABLE IF NOT EXISTS "developer_accounts" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "phone" TEXT NOT NULL,
      "api_id" TEXT NOT NULL,
      "api_hash" TEXT NOT NULL,
      "remark" TEXT,
      "created_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  );
  await executeRun(
    `CREATE TABLE IF NOT EXISTS "group_bot_admins" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "bot_id" INTEGER NOT NULL,
      "chat_id" BIGINT NOT NULL,
      "rights" TEXT NOT NULL DEFAULT '{}',
      "status" TEXT NOT NULL DEFAULT 'active',
      "created_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  );
  await executeRun(
    `CREATE UNIQUE INDEX IF NOT EXISTS "group_bot_admins_bot_chat_key" ON "group_bot_admins"("bot_id", "chat_id")`,
  );
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
  // 旧库补列：group_settings.privacy_mode（v1.0.7 隐私模式通用功能）
  const groupCols = await queryAll<{ name: string }>(`PRAGMA table_info(group_settings)`);
  if (groupCols.length > 0 && !groupCols.some((c) => c.name === "privacy_mode")) {
    await executeRun(
      `ALTER TABLE "group_settings" ADD COLUMN "privacy_mode" BOOLEAN NOT NULL DEFAULT true`,
    );
  }
  // 旧库补列：group_settings.require_approval（v1.1.9 加群需要管理员审核，与 TG APP 群设置对应）
  if (groupCols.length > 0 && !groupCols.some((c) => c.name === "require_approval")) {
    await executeRun(
      `ALTER TABLE "group_settings" ADD COLUMN "require_approval" BOOLEAN NOT NULL DEFAULT false`,
    );
  }
  // 旧库补列：group_settings.verification_channel（v2.0.5 群内验证渠道，默认群内验证）
  if (groupCols.length > 0 && !groupCols.some((c) => c.name === "verification_channel")) {
    await executeRun(
      `ALTER TABLE "group_settings" ADD COLUMN "verification_channel" TEXT NOT NULL DEFAULT 'group'`,
    );
  }
  // 旧库补列：group_settings.kick_direct_joins（v2.0.7 直连入群踢出开关，默认 false = 不踢出已有用户）
  if (groupCols.length > 0 && !groupCols.some((c) => c.name === "kick_direct_joins")) {
    await executeRun(
      `ALTER TABLE "group_settings" ADD COLUMN "kick_direct_joins" BOOLEAN NOT NULL DEFAULT false`,
    );
  }
  // 旧库补列：group_settings.reply_code_in_group（v2.1.5 群内回复输码快速验证，
  // 默认 false = 维持隐私红线：群内输码只走网页按钮/4选1点选）
  if (groupCols.length > 0 && !groupCols.some((c) => c.name === "reply_code_in_group")) {
    await executeRun(
      `ALTER TABLE "group_settings" ADD COLUMN "reply_code_in_group" BOOLEAN NOT NULL DEFAULT false`,
    );
  }
  // 旧库补列：verification_sessions.prompt_message_id（v2.0.5 群内验证提示消息 id，用于验证结束/超时后删除）
  const sessionCols = await queryAll<{ name: string }>(
    `PRAGMA table_info(verification_sessions)`,
  );
  if (sessionCols.length > 0 && !sessionCols.some((c) => c.name === "prompt_message_id")) {
    await executeRun(
      `ALTER TABLE "verification_sessions" ADD COLUMN "prompt_message_id" INTEGER`,
    );
  }
  // v1.0.8 机器人测试：闲鱼商品 / 发货日志 / 测试验证码
  await executeRun(
    `CREATE TABLE IF NOT EXISTS "xianyu_products" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "external_id" TEXT,
      "title" TEXT NOT NULL,
      "price" TEXT,
      "description" TEXT,
      "image_url" TEXT,
      "detail_json" TEXT,
      "source_url" TEXT,
      "raw_json" TEXT,
      "created_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  );
  await executeRun(
    `CREATE TABLE IF NOT EXISTS "xianyu_delivery_logs" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "product_id" INTEGER,
      "api_url" TEXT NOT NULL,
      "request_method" TEXT NOT NULL DEFAULT 'POST',
      "request_headers" TEXT,
      "request_body" TEXT,
      "response_status" INTEGER,
      "response_body" TEXT,
      "duration_ms" INTEGER,
      "verify_code" TEXT,
      "success" BOOLEAN NOT NULL DEFAULT false,
      "error" TEXT,
      "created_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  );
  await executeRun(
    `CREATE TABLE IF NOT EXISTS "verify_codes" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "code" TEXT NOT NULL,
      "product_id" INTEGER,
      "order_no" TEXT,
      "status" TEXT NOT NULL DEFAULT 'unused',
      "used_by_user_id" BIGINT,
      "used_chat_id" BIGINT,
      "used_time" DATETIME,
      "expires_at" DATETIME NOT NULL,
      "created_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  );
  await executeRun(
    `CREATE UNIQUE INDEX IF NOT EXISTS "verify_codes_code_key" ON "verify_codes"("code")`,
  );
  // 旧库迁移：bots_token_key 唯一索引 → 普通索引（v1.0.8 允许同 Token 多条目）
  const botIndexes = await queryAll<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'bots'`,
  );
  if (botIndexes.some((index) => index.name === "bots_token_key")) {
    await executeRun(`DROP INDEX "bots_token_key"`);
  }
  await executeRun(`CREATE INDEX IF NOT EXISTS "idx_bots_token" ON "bots"("token")`);
  // v1.1.0 AI 配置：多模型提供方（OpenAI 兼容协议）+ 调用统计日志
  await executeRun(
    `CREATE TABLE IF NOT EXISTS "ai_providers" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "name" TEXT NOT NULL,
      "base_url" TEXT NOT NULL,
      "api_key" TEXT NOT NULL DEFAULT '',
      "models_json" TEXT NOT NULL DEFAULT '[]',
      "selected_model" TEXT NOT NULL DEFAULT 'auto',
      "rate_limit_enabled" BOOLEAN NOT NULL DEFAULT false,
      "rate_limit_max" INTEGER NOT NULL DEFAULT 60,
      "rate_limit_window" INTEGER NOT NULL DEFAULT 60,
      "is_default" BOOLEAN NOT NULL DEFAULT false,
      "enabled" BOOLEAN NOT NULL DEFAULT true,
      "remark" TEXT NOT NULL DEFAULT '',
      "created_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  );
  await executeRun(
    `CREATE TABLE IF NOT EXISTS "ai_usage_logs" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "provider_id" INTEGER,
      "provider_name" TEXT NOT NULL DEFAULT '',
      "model" TEXT NOT NULL DEFAULT '',
      "scene" TEXT NOT NULL DEFAULT 'chat',
      "bot_id" INTEGER,
      "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
      "completion_tokens" INTEGER NOT NULL DEFAULT 0,
      "total_tokens" INTEGER NOT NULL DEFAULT 0,
      "duration_ms" INTEGER NOT NULL DEFAULT 0,
      "success" BOOLEAN NOT NULL DEFAULT true,
      "error" TEXT,
      "created_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  );
  await executeRun(`CREATE INDEX IF NOT EXISTS "idx_ai_usage_created" ON "ai_usage_logs"("created_time")`);
  await executeRun(`CREATE INDEX IF NOT EXISTS "idx_ai_usage_provider" ON "ai_usage_logs"("provider_id")`);
  // v1.1.0 BOT 会话外部存储（grammY session storage adapter）：sqlite 持久化存储位
  await executeRun(
    `CREATE TABLE IF NOT EXISTS "bot_sessions" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "scope" TEXT NOT NULL DEFAULT 'session',
      "session_key" TEXT NOT NULL,
      "value" TEXT NOT NULL DEFAULT '{}',
      "updated_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  );
  await executeRun(
    `CREATE UNIQUE INDEX IF NOT EXISTS "bot_sessions_scope_key" ON "bot_sessions"("scope", "session_key")`,
  );
  // v2.1.2 邀请链接台账：机器人创建的全部邀请链接统一落库（群组管理可查看/撤销）
  await executeRun(
    `CREATE TABLE IF NOT EXISTS "invite_links" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "bot_id" INTEGER,
      "chat_id" BIGINT NOT NULL,
      "link" TEXT NOT NULL,
      "name" TEXT,
      "creates_join_request" BOOLEAN NOT NULL DEFAULT false,
      "is_revoked" BOOLEAN NOT NULL DEFAULT false,
      "source" TEXT NOT NULL DEFAULT 'api',
      "created_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  );
  await executeRun(
    `CREATE UNIQUE INDEX IF NOT EXISTS "invite_links_link_key" ON "invite_links"("link")`,
  );
  await executeRun(
    `CREATE INDEX IF NOT EXISTS "idx_invite_links_bot_chat" ON "invite_links"("bot_id", "chat_id")`,
  );
  await executeRun(
    `CREATE INDEX IF NOT EXISTS "idx_invite_links_chat" ON "invite_links"("chat_id")`,
  );
  // v2.1.2 群消息台账：webhook 收到的群消息（按 bot 权限视角）落库，仿真屏展示真实群消息
  await executeRun(
    `CREATE TABLE IF NOT EXISTS "chat_messages" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "bot_id" INTEGER,
      "chat_id" BIGINT NOT NULL,
      "message_id" INTEGER,
      "user_id" BIGINT,
      "username" TEXT,
      "first_name" TEXT,
      "from_bot" BOOLEAN NOT NULL DEFAULT false,
      "kind" TEXT NOT NULL DEFAULT 'message',
      "text" TEXT,
      "message_time" DATETIME,
      "created_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  );
  await executeRun(
    `CREATE UNIQUE INDEX IF NOT EXISTS "chat_messages_chat_msg_key" ON "chat_messages"("chat_id", "bot_id", "message_id")`,
  );
  await executeRun(
    `CREATE INDEX IF NOT EXISTS "idx_chat_messages_chat_id" ON "chat_messages"("chat_id", "id")`,
  );
  // v2.1.6 TGAPI申请：解锁用户台账（首次对话验证码解锁 / 星星解锁的持久化凭证，
  // 与机器人运行时会话无关 —— 会话后端可能为 memory，解锁状态必须落库持久保存）
  await executeRun(
    `CREATE TABLE IF NOT EXISTS "tgapi_unlocks" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "bot_id" INTEGER NOT NULL,
      "user_id" BIGINT NOT NULL,
      "username" TEXT,
      "mode" TEXT NOT NULL DEFAULT 'captcha',
      "created_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  );
  await executeRun(
    `CREATE UNIQUE INDEX IF NOT EXISTS "tgapi_unlocks_bot_user_key" ON "tgapi_unlocks"("bot_id", "user_id")`,
  );
  await executeRun(
    `CREATE INDEX IF NOT EXISTS "idx_tgapi_unlocks_bot" ON "tgapi_unlocks"("bot_id")`,
  );
  console.log(
    "Migrations ensured: bots, developer_accounts, group_bot_admins, bot_commands, privacy_mode, require_approval, xianyu_products, xianyu_delivery_logs, verify_codes, ai_providers, ai_usage_logs, bot_sessions, invite_links, chat_messages, tgapi_unlocks",
  );
}

async function ensureSchema(): Promise<void> {
  const db = await getDatabase();
  const tables = await db.all<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'admin_users'`,
  );
  if (tables.length > 0) {
    console.log("Schema already applied, skipping DDL");
    return;
  }
  const schemaPath = path.resolve(getEnvBaseDir(), "prisma/schema.sql");
  const ddl = readFileSync(schemaPath, "utf-8");
  await db.exec(ddl);
  console.log("Schema applied from prisma/schema.sql");
}

async function seedPermissions(): Promise<void> {
  for (const permission of PERMISSIONS) {
    await executeRun(
      `INSERT INTO permissions (code, name, description, sort_order)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET name = excluded.name, description = excluded.description, sort_order = excluded.sort_order`,
      [permission.code, permission.name, permission.description, permission.sort],
    );
  }
  console.log(`Permissions ensured: ${PERMISSIONS.length}`);
}

async function seedRoles(): Promise<void> {
  await executeRun(
    `INSERT INTO roles (code, name, description, is_builtin)
     VALUES ('super_admin', '超级管理员', '拥有后台全部权限', 1)
     ON CONFLICT(code) DO NOTHING`,
  );
  await executeRun(
    `INSERT INTO roles (code, name, description, is_builtin)
     VALUES ('operator', '运营专员', '管理加群申请、群组配置与验证方式', 0)
     ON CONFLICT(code) DO NOTHING`,
  );

  const superAdmin = await db_one(`SELECT id FROM roles WHERE code = 'super_admin'`);
  if (superAdmin) {
    await executeRun(`DELETE FROM role_permissions WHERE role_id = ?`, [Number(superAdmin.id)]);
    const all = await queryAll<{ id: number }>(`SELECT id FROM permissions`);
    for (const row of all) {
      await executeRun(
        `INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)`,
        [Number(superAdmin.id), Number(row.id)],
      );
    }
  }

  // v1.1.0：super_admin 在上方已按 permissions 全表重新授权，新增的 ai:view / ai:manage 自动纳入
  const operator = await db_one(`SELECT id FROM roles WHERE code = 'operator'`);
  if (operator) {
    await executeRun(`DELETE FROM role_permissions WHERE role_id = ?`, [Number(operator.id)]);
    for (const code of OPERATOR_PERMISSION_CODES) {
      const permission = await db_one(`SELECT id FROM permissions WHERE code = ?`, [code]);
      if (permission) {
        await executeRun(
          `INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)`,
          [Number(operator.id), Number(permission.id)],
        );
      }
    }
  }
  console.log("Roles and role permissions ensured");
}

async function db_one<T extends SqlRow>(
  sql: string,
  params: SqlParam[] = [],
): Promise<T | null> {
  return queryOne<T>(sql, params);
}

async function seedAdminUser(): Promise<void> {
  const existing = await db_one(
    `SELECT id FROM admin_users WHERE username = 'admin'`,
  );
  if (existing) {
    console.log("Admin user already exists, skipping");
    return;
  }
  const superAdmin = await db_one(`SELECT id FROM roles WHERE code = 'super_admin'`);
  if (!superAdmin) throw new Error("super_admin role missing");
  const passwordHash = await hashPassword("admin123");
  await executeRun(
    `INSERT INTO admin_users (username, password_hash, display_name, role_id, status)
     VALUES ('admin', ?, '超级管理员', ?, 'active')`,
    [passwordHash, Number(superAdmin.id)],
  );
  console.log("Super admin created: admin / admin123");
}

async function seedMenus(): Promise<void> {
  const botsRoot = await db_one(`SELECT id FROM menus WHERE path = '/admin/bots' AND parent_id = 0`);
  if (!botsRoot) {
    await executeRun(
      `UPDATE menus SET sort_order = sort_order + 2 WHERE parent_id = 0 AND sort_order >= 4`,
    );
  }
  // v1.1.0：老库升级——「AI 配置」菜单插入到「操作日志」之前（操作日志 sort 后移一位）
  const aiMenu = await db_one(`SELECT id FROM menus WHERE path = '/admin/ai'`);
  const logsMenu = await db_one(`SELECT id FROM menus WHERE path = '/admin/logs' AND parent_id = 0`);
  if (!aiMenu && logsMenu) {
    await executeRun(
      `UPDATE menus SET sort_order = sort_order + 1 WHERE parent_id = 0 AND path = '/admin/logs'`,
    );
  }
  for (const menu of MENUS) {
    let parentId = 0;
    // 分组菜单（path 为空）必须按 title 匹配——空 path 会误吞其他分组 root（历史 bug）；
    // 叶子 root 按 path 匹配（title 可能因用户改名而漂移）。
    const existingRoot = menu.path
      ? await db_one(`SELECT id FROM menus WHERE path = ? AND parent_id = 0`, [menu.path])
      : await db_one(`SELECT id FROM menus WHERE title = ? AND parent_id = 0`, [menu.title]);
    if (!existingRoot) {
      const result = await executeRun(
        `INSERT INTO menus (parent_id, title, path, icon, sort_order, visible, permission_code, status, created_time, updated_time)
         VALUES (0, ?, ?, ?, ?, 1, ?, 1, ?, ?)`,
        [
          menu.title,
          menu.path,
          menu.icon,
          menu.sort,
          menu.permission,
          new Date().toISOString(),
          new Date().toISOString(),
        ],
      );
      parentId = Number(result.lastInsertRowid);
    } else {
      parentId = Number(existingRoot.id);
      await executeRun(
        `UPDATE menus SET title = ?, icon = ?, sort_order = ?, permission_code = ?, updated_time = ? WHERE id = ?`,
        [menu.title, menu.icon, menu.sort, menu.permission, new Date().toISOString(), parentId],
      );
    }
    for (const child of menu.children ?? []) {
      const existingChild = await db_one(
        `SELECT id FROM menus WHERE path = ? AND parent_id = ?`,
        [child.path, parentId],
      );
      if (existingChild) continue;
      await executeRun(
        `INSERT INTO menus (parent_id, title, path, icon, sort_order, visible, permission_code, status, created_time, updated_time)
         VALUES (?, ?, ?, ?, ?, 1, ?, 1, ?, ?)`,
        [
          parentId,
          child.title,
          child.path,
          child.icon,
          child.sort,
          child.permission,
          new Date().toISOString(),
          new Date().toISOString(),
        ],
      );
    }
  }
  console.log(`Menus ensured: ${MENUS.length} roots`);
}

async function seedSampleMethod(): Promise<void> {
  const existing = await db_one(
    `SELECT id FROM verification_methods WHERE name = ?`,
    ["外部会员系统核验"],
  );
  if (existing) return;
  const config = {
    url: "https://api.example.com/members/verify",
    api_key: "sk-your-apikey",
    http_method: "POST",
    body_template: '{"user_id":{{user_id}},"code":"{{code}}"}',
    success_status: 200,
    success_field: "valid",
    success_value: "true",
    timeout_seconds: 10,
  };
  await executeRun(
    `INSERT INTO verification_methods (name, type, config, enabled, created_time, updated_time)
     VALUES (?, 'code_api', ?, 1, ?, ?)`,
    [
      "外部会员系统核验",
      JSON.stringify(config, null, 2),
      new Date().toISOString(),
      new Date().toISOString(),
    ],
  );
  console.log("Sample verification method created");
}

async function seedRadsMethod(): Promise<void> {
  const existing = await db_one(
    `SELECT id FROM verification_methods WHERE name = ?`,
    ["资源自动交付系统·卡密核销"],
  );
  if (existing) return;
  const config = {
    url: "http://127.0.0.1:3001/api/redeem",
    api_key: "rads-public-redeem",
    http_method: "POST",
    body_template: '{"key":"{{code}}"}',
    success_status: 200,
    success_field: "ok",
    success_value: "true",
    timeout_seconds: 10,
    rads_base_url: "http://127.0.0.1:3001",
    rads_issue_key: "ak-86f5b3bc34c3ed383035e40603e159",
    rads_script_id: 2,
    rads_title: "TGuard 入群验证卡",
    rads_price: 9.9,
    rads_max_uses: 3,
  };
  await executeRun(
    `INSERT INTO verification_methods (name, type, config, enabled, created_time, updated_time)
     VALUES (?, 'code_api', ?, 1, ?, ?)`,
    [
      "资源自动交付系统·卡密核销",
      JSON.stringify(config, null, 2),
      new Date().toISOString(),
      new Date().toISOString(),
    ],
  );
  console.log("RADS card-key verification method created");
}

/**
 * 官方内置指令目录（v1.1.0）：23 条，全部有真实 grammY 处理器实现
 * （见 src/bot/handlers/builtin-commands.ts），按使用频率排序（越常用越靠前）。
 */
export const BUILTIN_COMMANDS: { name: string; description: string; intro: string; sort: number }[] = [
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
    name: "menu",
    description: "打开主菜单",
    intro:
      "重新发送机器人的主菜单按钮。当用户关闭或误触菜单后，使用 /menu 可以随时唤出主菜单继续操作，等价于点击「Menu」按钮。",
    sort: 3,
  },
  {
    name: "settings",
    description: "查看机器人设置",
    intro:
      "回复机器人当前生效的核心设置摘要：验证超时时长、验证按钮文案、人机验证类型、外部 API 状态、管理员数量与验证通过率，方便在聊天中快速巡检配置。",
    sort: 4,
  },
  {
    name: "about",
    description: "关于本机器人",
    intro:
      "展示机器人名称与用户名、使用的引擎（grammY + Telegram Bot API）、TGuard 框架版本以及能力清单（入群验证/群组管理/AI 客服/指令菜单）。",
    sort: 5,
  },
  {
    name: "id",
    description: "查询聊天与用户 ID",
    intro:
      "回复当前用户的 ID、所在聊天的 ID 与类型、群组名称及话题 ID。调试权限、配置白名单或对接外部 API 时经常需要这些数字 ID。",
    sort: 6,
  },
  {
    name: "info",
    description: "查看用户信息",
    intro:
      "回复用户资料卡：ID、姓名、用户名、是否机器人；在群组中使用时会额外通过 getChatMember 查询并展示对方在群内的真实身份（群主/管理员/普通成员/受限/被封禁）。",
    sort: 7,
  },
  {
    name: "ping",
    description: "检测机器人响应延迟",
    intro:
      "向 Telegram Bot API 发起一次 getMe 探测并统计往返耗时，用于快速判断机器人与 Telegram 服务器的链路质量（部署代理后可用来验证连通性）。",
    sort: 8,
  },
  {
    name: "time",
    description: "查看服务器时间",
    intro:
      "回复服务器当前时间（北京时间，Asia/Shanghai 时区）。排查定时任务、验证码有效期等问题时用来对齐时间基准。",
    sort: 9,
  },
  {
    name: "cancel",
    description: "取消当前操作",
    intro:
      "中断当前进行中的会话状态（如等待输入验证码、等待指令参数），清空会话数据并提示重新开始。所有等待用户输入的流程都可以用 /cancel 安全退出。",
    sort: 10,
  },
  {
    name: "rules",
    description: "查看群规",
    intro:
      "通过 getChat 读取群组描述并作为群规回复。管理员只需在 Telegram 群组设置 →「描述」中撰写群规，成员使用 /rules 即可随时查看，无需重复维护两份文案。",
    sort: 11,
  },
  {
    name: "report",
    description: "举报违规消息",
    intro:
      "回复要举报的消息使用 /report，机器人会通过 getChatAdministrators 找到全部群管理员并逐私密信通知（含群组、举报人与被举报人信息），最后在群内确认通知结果。",
    sort: 12,
  },
  {
    name: "admin",
    description: "管理面板入口",
    intro:
      "仅管理员可用。回复 TGuard 管理后台访问入口（已配置 Webhook 域名时自动拼接 /admin 路径），方便管理员从手机聊天中一键跳转后台。",
    sort: 13,
  },
  {
    name: "stats",
    description: "查看验证统计",
    intro:
      "仅管理员可用。回复当前机器人的验证总请求数、通过数、拒绝数、待处理数、过期数、通过率以及今日统计。数据来自数据库实时聚合。",
    sort: 14,
  },
  {
    name: "api",
    description: "查看外部 API 状态",
    intro:
      "仅管理员可用且仅限私聊。回复外部 API 的启用状态、服务器地址与 API Key（自动规避群聊泄露风险）。用于对接外部系统的运维排查。",
    sort: 15,
  },
  {
    name: "ban",
    description: "封禁用户",
    intro:
      "仅管理员可用，在群组中回复目标用户的消息使用。调用 banChatMember 将对方永久移出并禁止再加入群组；需要机器人拥有「封禁用户」管理员权限。",
    sort: 16,
  },
  {
    name: "unban",
    description: "解除封禁",
    intro:
      "仅管理员可用，在群组中回复目标用户的消息使用。调用 unbanChatMember（only_if_banned）解除封禁，对方随后可以重新申请加入群组。",
    sort: 17,
  },
  {
    name: "mute",
    description: "禁言用户",
    intro:
      "仅管理员可用，在群组中回复目标用户的消息使用，支持时长参数（如「/mute 30」表示 30 分钟，默认 60 分钟，上限 7 天）。通过 restrictChatMember 关闭全部发言权限。",
    sort: 18,
  },
  {
    name: "unmute",
    description: "解除禁言",
    intro:
      "仅管理员可用，在群组中回复目标用户的消息使用。恢复对方的标准发言权限（保留群资料/置顶等敏感权限为关闭状态，不越权提升成员）。",
    sort: 19,
  },
  {
    name: "kick",
    description: "踢出用户",
    intro:
      "仅管理员可用，在群组中回复目标用户的消息使用。先 banChatMember 再立即 unbanChatMember 实现「踢出但不拉黑」，对方仍可重新申请入群，常用于清退广告号。",
    sort: 20,
  },
  {
    name: "warn",
    description: "警告用户",
    intro:
      "仅管理员可用，在群组中回复目标用户的消息使用，可附带原因（如「/warn 刷屏」）。警告按「群组+用户」累计，同一用户满 3 次自动封禁，无需管理员手动跟进。",
    sort: 21,
  },
  {
    name: "warns",
    description: "查看警告次数",
    intro:
      "仅管理员可用，在群组中回复目标用户的消息使用。查看对方当前累计的警告次数（x/3），配合 /warn 使用，便于团队管理员统一执法尺度。",
    sort: 22,
  },
  {
    name: "pin",
    description: "置顶消息",
    intro:
      "仅管理员可用，在群组中回复要置顶的消息使用。调用 pinChatMessage 静默置顶（不提醒全体成员），需要机器人拥有「置顶消息」管理员权限。",
    sort: 23,
  },
];

async function seedBuiltinCommands(): Promise<void> {
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
  console.log(`Builtin commands ensured: ${BUILTIN_COMMANDS.length}`);
}

async function main(): Promise<void> {
  await ensureSchema();
  await ensureMigrations();
  await seedPermissions();
  await seedRoles();
  await seedAdminUser();
  await seedMenus();
  await seedSampleMethod();
  await seedRadsMethod();
  await seedBuiltinCommands();
  const info = await getDatabase();
  console.log(`Database ready at ${info.displayPath} (${info.kind} runtime)`);
}

// 仅在直接执行时初始化数据库；被其它脚本 import（如 seed-builtin-commands.ts）时不触发
const isDirectRun = (() => {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("db-init.ts") || entry.endsWith("db-init.js");
})();
if (isDirectRun) {
  main().catch((error) => {
    console.error("Database init failed:", error);
    process.exitCode = 1;
  });
}
