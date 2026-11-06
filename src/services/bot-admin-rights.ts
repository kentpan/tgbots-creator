/**
 * 机器人管理员权限键与中文标签（全局唯一来源）。
 *
 * 服务端（bots/actions.ts、bot-group-admin-sync.ts、bot-admins API）与
 * 客户端（仿真屏 tg-app-simulator.tsx 的图3 权限页）共用同一份常量，
 * 保证权限键集合永不漂移（Telegram Bot API promoteChatMember 支持的 8 项）。
 * 本文件必须保持零依赖（可被客户端组件安全导入）。
 */

export const BOT_ADMIN_RIGHT_KEYS = [
  "can_manage_chat",
  "can_change_info",
  "can_delete_messages",
  "can_invite_users",
  "can_restrict_members",
  "can_pin_messages",
  "can_manage_video_chats",
  "can_promote_members",
] as const;

export type BotAdminRights = Partial<Record<(typeof BOT_ADMIN_RIGHT_KEYS)[number], boolean>>;

/** 权限键 → 中文标签（保存结果提示用） */
export const BOT_ADMIN_RIGHT_LABELS: Record<(typeof BOT_ADMIN_RIGHT_KEYS)[number], string> = {
  can_manage_chat: "管理聊天",
  can_change_info: "修改群组信息",
  can_delete_messages: "删除消息",
  can_invite_users: "邀请用户",
  can_restrict_members: "封禁/限制成员",
  can_pin_messages: "置顶消息",
  can_manage_video_chats: "管理视频会议",
  can_promote_members: "添加新管理员",
};
