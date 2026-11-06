-- TGuard (bot-groups) SQLite schema export
-- Compatible with node:sqlite (Node runtime) and Cloudflare D1 (Workers runtime)
PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;
CREATE TABLE "join_requests" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" BIGINT NOT NULL,
    "chat_id" BIGINT NOT NULL,
    "username" TEXT,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT,
    "verification_token" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "request_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_time" DATETIME,
    "admin_id" BIGINT,
    "verification_completed" BOOLEAN NOT NULL DEFAULT false,
    "request_type" TEXT NOT NULL DEFAULT 'telegram'
);
CREATE TABLE "verification_sessions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "token" TEXT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "chat_id" BIGINT NOT NULL,
    "captcha_completed" BOOLEAN NOT NULL DEFAULT false,
    "captcha_response" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_time" DATETIME,
    "expires_at" DATETIME NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'captcha',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expected_code" TEXT
, "channel" TEXT NOT NULL DEFAULT 'dm', "group_message_id" INTEGER, "option_codes" TEXT);
CREATE TABLE "user_stats" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" BIGINT NOT NULL,
    "total_requests" INTEGER NOT NULL DEFAULT 0,
    "successful_verifications" INTEGER NOT NULL DEFAULT 0,
    "failed_verifications" INTEGER NOT NULL DEFAULT 0,
    "last_verification_time" DATETIME,
    "created_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "roles" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_builtin" BOOLEAN NOT NULL DEFAULT false,
    "created_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "permissions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE "role_permissions" (
    "role_id" INTEGER NOT NULL,
    "permission_id" INTEGER NOT NULL,
    PRIMARY KEY ("role_id", "permission_id")
);
CREATE TABLE "admin_users" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "display_name" TEXT,
    "role_id" INTEGER NOT NULL DEFAULT 2,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_time" DATETIME
);
CREATE TABLE "admin_sessions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" DATETIME NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "menus" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "parent_id" INTEGER NOT NULL DEFAULT 0,
    "title" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "icon" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "permission_code" TEXT,
    "status" INTEGER NOT NULL DEFAULT 1,
    "created_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "group_settings" (
    "chat_id" BIGINT NOT NULL PRIMARY KEY,
    "chat_title" TEXT,
    "method" TEXT NOT NULL DEFAULT 'captcha',
    "method_id" INTEGER,
    "timeout_seconds" INTEGER NOT NULL DEFAULT 300,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "prompt_text" TEXT NOT NULL DEFAULT '🔐 请回复本消息并输入验证码完成验证',
    "success_text" TEXT NOT NULL DEFAULT '✅ 验证成功，欢迎加入！',
    "failure_text" TEXT NOT NULL DEFAULT '❌ 验证码错误，请重试。',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
, "privacy_mode" BOOLEAN NOT NULL DEFAULT true, "require_approval" BOOLEAN NOT NULL DEFAULT false, "verify_channel" TEXT NOT NULL DEFAULT 'group');
CREATE TABLE "verification_methods" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'code_api',
    "config" TEXT NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updated_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "operation_logs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "admin_id" INTEGER,
    "admin_username" TEXT,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "detail" TEXT,
    "ip_address" TEXT,
    "created_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "bots" (
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
    );
CREATE TABLE "developer_accounts" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "phone" TEXT NOT NULL,
      "api_id" TEXT NOT NULL,
      "api_hash" TEXT NOT NULL,
      "remark" TEXT,
      "created_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
CREATE TABLE "group_bot_admins" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "bot_id" INTEGER NOT NULL,
      "chat_id" BIGINT NOT NULL,
      "rights" TEXT NOT NULL DEFAULT '{}',
      "status" TEXT NOT NULL DEFAULT 'active',
      "created_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
CREATE TABLE "bot_commands" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "type" TEXT NOT NULL DEFAULT 'builtin',
      "name" TEXT NOT NULL,
      "description" TEXT NOT NULL DEFAULT '',
      "intro" TEXT NOT NULL DEFAULT '',
      "enabled" BOOLEAN NOT NULL DEFAULT true,
      "sort_order" INTEGER NOT NULL DEFAULT 0,
      "created_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
CREATE TABLE xianyu_products (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  external_id TEXT,
  title TEXT NOT NULL,
  price TEXT,
  description TEXT,
  image_url TEXT,
  detail_json TEXT,
  source_url TEXT,
  raw_json TEXT,
  created_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE xianyu_delivery_logs (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER,
  api_url TEXT NOT NULL,
  request_method TEXT NOT NULL DEFAULT 'POST',
  request_headers TEXT,
  request_body TEXT,
  response_status INTEGER,
  response_body TEXT,
  duration_ms INTEGER,
  verify_code TEXT,
  success BOOLEAN NOT NULL DEFAULT false,
  error TEXT,
  created_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE verify_codes (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  product_id INTEGER,
  order_no TEXT,
  status TEXT NOT NULL DEFAULT 'unused',
  used_by_user_id BIGINT,
  used_chat_id BIGINT,
  used_time DATETIME,
  expires_at DATETIME NOT NULL,
  created_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "ai_providers" (
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
    );
CREATE TABLE "ai_usage_logs" (
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
    );
CREATE TABLE "bot_sessions" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "scope" TEXT NOT NULL DEFAULT 'session',
      "session_key" TEXT NOT NULL,
      "value" TEXT NOT NULL DEFAULT '{}',
      "updated_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
-- v2.2.0 D1 免费额度保护：加群申请状态计数器（增量维护，替代全表 GROUP BY）
CREATE TABLE "stats_counters" (
      "name" TEXT NOT NULL PRIMARY KEY,
      "value" INTEGER NOT NULL DEFAULT 0,
      "updated_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
CREATE UNIQUE INDEX "admin_users_username_key" ON "admin_users"("username");
CREATE UNIQUE INDEX "bot_commands_type_name_key" ON "bot_commands"("type", "name");
CREATE UNIQUE INDEX "bot_sessions_scope_key" ON "bot_sessions"("scope", "session_key");
CREATE UNIQUE INDEX "group_bot_admins_bot_chat_key" ON "group_bot_admins"("bot_id", "chat_id");
CREATE INDEX "idx_admin_sessions_token_hash" ON "admin_sessions"("token_hash");
CREATE INDEX "idx_admin_sessions_user_id" ON "admin_sessions"("user_id");
CREATE INDEX "idx_ai_usage_created" ON "ai_usage_logs"("created_time");
CREATE INDEX "idx_ai_usage_provider" ON "ai_usage_logs"("provider_id");
CREATE INDEX idx_bots_token ON bots(token);
CREATE INDEX "idx_join_requests_chat_id" ON "join_requests"("chat_id");
CREATE INDEX "idx_join_requests_request_type" ON "join_requests"("request_type");
CREATE INDEX "idx_join_requests_status" ON "join_requests"("status");
CREATE INDEX "idx_join_requests_user_id" ON "join_requests"("user_id");
CREATE INDEX "idx_operation_logs_created_time" ON "operation_logs"("created_time");
CREATE INDEX "idx_verification_sessions_user_id" ON "verification_sessions"("user_id");
CREATE INDEX idx_verify_codes_status ON verify_codes(status);
CREATE INDEX idx_xianyu_delivery_logs_product ON xianyu_delivery_logs(product_id);
CREATE INDEX idx_xianyu_products_created ON xianyu_products(created_time);
CREATE UNIQUE INDEX "join_requests_verification_token_key" ON "join_requests"("verification_token");
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");
CREATE UNIQUE INDEX "roles_code_key" ON "roles"("code");
CREATE UNIQUE INDEX "user_stats_user_id_key" ON "user_stats"("user_id");
CREATE UNIQUE INDEX "verification_methods_name_key" ON "verification_methods"("name");
CREATE UNIQUE INDEX "verification_sessions_token_key" ON "verification_sessions"("token");
CREATE UNIQUE INDEX "verify_codes_code_key" ON "verify_codes"("code");
-- ── v2.2.0 D1 读取额度优化：补齐缺失索引 ────────────────────────────────
-- 1) 加群申请列表分页 ORDER BY request_time DESC（旧库无索引 → 每次全表扫 + 排序）
--    复合 (request_time, status) 同时服务「今日统计」的当天范围扫描。
CREATE INDEX "idx_join_requests_request_time_status" ON "join_requests"("request_time", "status");
-- 2) 按「群 + 状态」查 pending（群内验证防重复 bootstrap、群组页未读徽章）
CREATE INDEX "idx_join_requests_chat_status" ON "join_requests"("chat_id", "status");
-- 3) 按「用户 + 状态」查最近申请
CREATE INDEX "idx_join_requests_user_status" ON "join_requests"("user_id", "status");
-- 4) 过期会话清理 WHERE expires_at < ? AND captcha_completed = 0（旧库无索引 → 每分钟全表扫）
CREATE INDEX "idx_verification_sessions_expires_at" ON "verification_sessions"("expires_at");
-- 5) 归档删除 WHERE created_time < ?
CREATE INDEX "idx_verification_sessions_created_time" ON "verification_sessions"("created_time");
-- 6) 会话按「用户 + 群」定位（群内验证 bootstrap 去重）
CREATE INDEX "idx_verification_sessions_user_chat" ON "verification_sessions"("user_id", "chat_id");
-- 7) 群维度会话查询
CREATE INDEX "idx_verification_sessions_chat_id" ON "verification_sessions"("chat_id");
-- 8) 群组↔机器人关联按群反查
CREATE INDEX "idx_group_bot_admins_chat_id" ON "group_bot_admins"("chat_id");
COMMIT;
