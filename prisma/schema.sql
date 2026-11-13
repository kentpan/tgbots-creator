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
    "attempts" INTEGER NOT NULL DEFAULT 0
, expected_code TEXT, "prompt_message_id" INTEGER, channel, group_message_id, option_codes, method_id INTEGER, max_attempts INTEGER);
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
, "privacy_mode" BOOLEAN NOT NULL DEFAULT true, require_approval BOOLEAN NOT NULL DEFAULT false, "verification_channel" TEXT NOT NULL DEFAULT 'group', kick_direct_joins BOOLEAN NOT NULL DEFAULT false, "reply_code_in_group" BOOLEAN NOT NULL DEFAULT false, verify_channel, join_verify_bot_id INTEGER, chat_type TEXT);
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
    , bot_id INTEGER, group_id INTEGER);
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
CREATE TABLE "invite_links" (
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
);
CREATE TABLE "chat_messages" (
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
);
CREATE TABLE "tgapi_unlocks" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "bot_id" INTEGER NOT NULL,
      "user_id" BIGINT NOT NULL,
      "username" TEXT,
      "mode" TEXT NOT NULL DEFAULT 'captcha',
      "created_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
CREATE TABLE "tgapi_bot_users" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "bot_id" INTEGER NOT NULL,
      "user_id" BIGINT NOT NULL,
      "username" TEXT,
      "menu_message_id" INTEGER,
      "app_phone" TEXT,
      "app_id" TEXT,
      "app_hash" TEXT,
      "created_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
CREATE TABLE "api_logs" (
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
CREATE UNIQUE INDEX "admin_users_username_key" ON "admin_users"("username");
CREATE INDEX "api_logs_category_idx" ON "api_logs" ("category");
CREATE INDEX "api_logs_created_idx" ON "api_logs" ("created_time");
CREATE UNIQUE INDEX "bot_commands_type_name_key" ON "bot_commands"("type", "name");
CREATE UNIQUE INDEX "bot_sessions_scope_key" ON "bot_sessions"("scope", "session_key");
CREATE UNIQUE INDEX "chat_messages_chat_msg_key" ON "chat_messages"("chat_id", "bot_id", "message_id");
CREATE UNIQUE INDEX "group_bot_admins_bot_chat_key" ON "group_bot_admins"("bot_id", "chat_id");
CREATE INDEX "idx_admin_sessions_token_hash" ON "admin_sessions"("token_hash");
CREATE INDEX "idx_admin_sessions_user_id" ON "admin_sessions"("user_id");
CREATE INDEX "idx_ai_usage_created" ON "ai_usage_logs"("created_time");
CREATE INDEX "idx_ai_usage_provider" ON "ai_usage_logs"("provider_id");
CREATE INDEX idx_bots_token ON bots(token);
CREATE INDEX "idx_chat_messages_chat_id" ON "chat_messages"("chat_id", "id");
CREATE INDEX "idx_invite_links_bot_chat" ON "invite_links"("bot_id", "chat_id");
CREATE INDEX "idx_invite_links_chat" ON "invite_links"("chat_id");
CREATE INDEX "idx_join_requests_chat_id" ON "join_requests"("chat_id");
CREATE INDEX 'idx_join_requests_chat_status' ON 'join_requests'('chat_id', 'status');
CREATE INDEX 'idx_join_requests_request_time' ON 'join_requests'('request_time');
CREATE INDEX "idx_join_requests_request_type" ON "join_requests"("request_type");
CREATE INDEX "idx_join_requests_status" ON "join_requests"("status");
CREATE INDEX 'idx_join_requests_status_chat' ON 'join_requests'('status', 'chat_id');
CREATE INDEX "idx_join_requests_user_id" ON "join_requests"("user_id");
CREATE INDEX "idx_operation_logs_created_time" ON "operation_logs"("created_time");
CREATE INDEX "idx_tgapi_bot_users_bot" ON "tgapi_bot_users"("bot_id");
CREATE INDEX "idx_tgapi_unlocks_bot" ON "tgapi_unlocks"("bot_id");
CREATE INDEX 'idx_verification_sessions_created' ON 'verification_sessions'('created_time');
CREATE INDEX 'idx_verification_sessions_expires' ON 'verification_sessions'('expires_at');
CREATE INDEX 'idx_verification_sessions_user_chat' ON 'verification_sessions'('user_id', 'chat_id', 'captcha_completed');
CREATE INDEX 'idx_verification_sessions_user_completed' ON 'verification_sessions'('user_id', 'captcha_completed', 'created_time');
CREATE INDEX "idx_verification_sessions_user_id" ON "verification_sessions"("user_id");
CREATE INDEX idx_verify_codes_status ON verify_codes(status);
CREATE INDEX idx_xianyu_delivery_logs_product ON xianyu_delivery_logs(product_id);
CREATE INDEX idx_xianyu_products_created ON xianyu_products(created_time);
CREATE UNIQUE INDEX "invite_links_link_key" ON "invite_links"("link");
CREATE UNIQUE INDEX "join_requests_verification_token_key" ON "join_requests"("verification_token");
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");
CREATE UNIQUE INDEX "roles_code_key" ON "roles"("code");
CREATE UNIQUE INDEX "tgapi_bot_users_bot_user_key" ON "tgapi_bot_users"("bot_id", "user_id");
CREATE UNIQUE INDEX "tgapi_unlocks_bot_user_key" ON "tgapi_unlocks"("bot_id", "user_id");
CREATE UNIQUE INDEX "user_stats_user_id_key" ON "user_stats"("user_id");
CREATE UNIQUE INDEX "verification_methods_name_key" ON "verification_methods"("name");
CREATE UNIQUE INDEX "verification_sessions_token_key" ON "verification_sessions"("token");
CREATE UNIQUE INDEX "verify_codes_code_key" ON "verify_codes"("code");
COMMIT;
