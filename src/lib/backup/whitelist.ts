/**
 * 备份管理白名单（v2.2.3，自 xianyu-admin v2.3.10 备份管理原样复刻）：
 * 可导出 / 可定时备份 / 可 JSON 导入回灌的表范围（主库 bot-groups.db 业务表）。
 *
 * 排除 admin_sessions（管理员登录会话，运行时态，备份回灌会话无意义）。
 * 备份范围 = 主库（DATABASE_URI 指向的 bot-groups.db）；db/custom.db 为 Prisma
 * 运行时库，不在本功能范围。
 */

/** 主键列（默认 id；复合主键用数组 → 导入回灌走 INSERT OR REPLACE 全量覆盖语义）。 */
export const TABLE_PK: Record<string, string | string[]> = {
  admin_users: "id",
  ai_providers: "id",
  ai_usage_logs: "id",
  app_settings: "key",
  bot_commands: "id",
  bot_sessions: "id",
  bots: "id",
  chat_messages: "id",
  developer_accounts: "id",
  group_bot_admins: "id",
  group_settings: "chat_id",
  invite_links: "id",
  join_requests: "id",
  menus: "id",
  operation_logs: "id",
  permissions: "id",
  role_permissions: ["role_id", "permission_id"],
  roles: "id",
  tgapi_bot_users: "id",
  tgapi_unlocks: "id",
  user_stats: "id",
  verification_methods: "id",
  verification_sessions: "id",
  verify_codes: "id",
  xianyu_delivery_logs: "id",
  xianyu_products: "id",
};

export const DATA_TABLE_WHITELIST: string[] = Object.keys(TABLE_PK);

export function isWhitelistedTable(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(TABLE_PK, name);
}

/** 表主键列（复合主键返回数组）。未知表回退 "id"。 */
export function pkOf(name: string): string | string[] {
  return TABLE_PK[name] ?? "id";
}
