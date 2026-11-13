/**
 * 聊天类型统一判定与能力声明（群组 / 频道 分支的唯一源头）：
 *
 * Bot API 的 chat.type：group（基础群）/ supergroup（超级群）/ channel（频道）。
 * 频道与群组在 Bot API 上能力不同（订阅者不能在频道发言），涉及验证/成员管理的
 * 逻辑必须先查能力再执行 —— 禁止在频道上调用不支持的操作，UI 与运行时共用本模块。
 */

export type ChatKind = "group" | "channel" | "unknown";

/** Bot API chat.type → 统一类型（supergroup/group 归为 group） */
export function chatKindFromChatType(type: string | undefined | null): ChatKind {
  if (type === "channel") return "channel";
  if (type === "group" || type === "supergroup") return "group";
  return "unknown";
}

export interface ChatCapabilities {
  /** 群内验证（频道订阅者无法发言，物理不可能） */
  inGroupVerification: boolean;
  /** 成员默认权限 setChatPermissions（仅群组） */
  memberPermissions: boolean;
  /** 申请制入群审批（群组/频道都支持） */
  joinRequestApproval: boolean;
  /** 邀请链接管理（群组/频道都支持） */
  inviteLinks: boolean;
}

const GROUP_CAPABILITIES: ChatCapabilities = {
  inGroupVerification: true,
  memberPermissions: true,
  joinRequestApproval: true,
  inviteLinks: true,
};

const CHANNEL_CAPABILITIES: ChatCapabilities = {
  inGroupVerification: false,
  memberPermissions: false,
  joinRequestApproval: true,
  inviteLinks: true,
};

const UNKNOWN_CAPABILITIES: ChatCapabilities = {
  inGroupVerification: false,
  memberPermissions: false,
  joinRequestApproval: false,
  inviteLinks: false,
};

export function chatCapabilities(kind: ChatKind): ChatCapabilities {
  if (kind === "channel") return CHANNEL_CAPABILITIES;
  if (kind === "group") return GROUP_CAPABILITIES;
  return UNKNOWN_CAPABILITIES;
}

/** 列表徽标文案 */
export function chatKindLabel(kind: ChatKind): string {
  if (kind === "channel") return "📢 频道";
  if (kind === "group") return "👥 群组";
  return "❓ 未知";
}
