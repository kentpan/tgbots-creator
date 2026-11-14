import type { BotMenuConfig, MenuTemplateVars } from "@/services/menu-config";
import type { NewGroupBot } from "@/components/admin/tg-new-group-panel";

/** Telegram 仿真屏共享领域类型与权限配置。 */

export interface AppSimGroup {
  chatId: string;
  chatTitle: string;
  /** v2.3 聊天类型（group/supergroup/channel；未登记=空不显示徽标） */
  chatType?: string | null;
  enabled: boolean;
  method: string;
  methodId: string | null;
  methodName: string | null;
  timeoutSeconds: number;
  maxAttempts: number;
  /** 已通过一键部署生成申请制入群链接 */
  deployed: boolean;
  /** 待处理加群申请数 */
  unread: number;
  /** 群组配置更新时间（ISO） */
  updatedTime: string;
}

export interface JoinResolveResult {
  resolve_type: "deep_link" | "invite_link";
  chat_id: string;
  chat_title: string;
  join_request_enabled: boolean;
  invite_link?: string | null;
  method: string | null;
  method_name: string | null;
  enabled: boolean;
  bot_username?: string | null;
  member_count?: number | null;
}

export interface RealChatMessage {
  id: string;
  message_id: number | null;
  user_id: string | null;
  username: string | null;
  first_name: string | null;
  from_bot: boolean;
  kind: string;
  text: string | null;
  message_time: string | null;
}

export interface BotAdminEntry {
  id: string;
  bot_id: string;
  bot_name: string | null;
  bot_username: string | null;
  rights: Record<string, boolean>;
}

export interface PendingJoinRequest {
  id: string;
  token: string;
  user_id: string;
  username: string | null;
  first_name: string;
  last_name: string | null;
  request_time: string;
  request_type: string;
}

export interface SimInviteLinkEntry {
  id: string;
  bot_id: string | null;
  chat_id: string;
  link: string;
  name: string | null;
  creates_join_request: boolean;
  is_revoked: boolean;
  source: string;
  created_time: string;
  updated_time: string;
}



/** 群组设置表单状态（与 group-settings API 的可编辑字段对应）。 */
export interface GroupSettingsFormState {
  chat_title: string;
  method: string;
  method_id: string;
  timeout_seconds: number;
  max_attempts: number;
  prompt_text: string;
  success_text: string;
  failure_text: string;
  enabled: boolean;
  privacy_mode: boolean;
  verification_channel: "auto" | "group" | "dm";
  kick_direct_joins: boolean;
  reply_code_in_group: boolean;
  require_approval: boolean;
  join_verify_bot_id: string;
}

/** Bot API getChat 返回的群组只读状态快照。 */
export interface ChatStateSnapshot {
  id: string;
  type: string;
  title: string | null;
  username: string | null;
  active_usernames: string[];
  is_forum: boolean;
  has_visible_history: boolean;
  has_available_reactions: boolean;
  available_reactions_count: number | null;
  max_reaction_count: number | null;
  has_custom_appearance: boolean;
  has_protected_content: boolean;
}

/** 自动审核机器人候选项。 */
export interface JoinVerifyCandidate {
  id: string;
  name: string;
}

/** 仿真屏内部导航状态。 */
export type SimulatorScreen =
  | "chat"
  | "settings"
  | "admins"
  | "proxy"
  | "newgroup"
  | "apiconfig"
  | "botcheck"
  | "chattype";

/** 机器人关键节点检测计划与执行结果。 */
export interface BotCheckPlanNode {
  key: string;
  label: string;
  hint: string;
}

export interface BotCheckResult {
  key: string;
  label: string;
  ok: boolean;
  ms: number;
  detail: string;
  error?: string;
  suggestion?: string;
}

/** 与 bots/actions.ts BOT_ADMIN_RIGHT_KEYS 一致。 */
export const ADMIN_RIGHTS: { key: string; label: string; hint: string }[] = [
  { key: "can_change_info", label: "修改群组信息", hint: "更改群名称、头像与描述" },
  { key: "can_delete_messages", label: "删除消息", hint: "删除群内任意成员的消息" },
  { key: "can_restrict_members", label: "封禁用户", hint: "封禁/解封群成员" },
  { key: "can_invite_users", label: "添加成员", hint: "邀请用户与生成邀请链接（部署必需）" },
  { key: "can_pin_messages", label: "置顶消息", hint: "置顶或取消置顶群消息" },
  { key: "can_manage_video_chats", label: "管理视频聊天", hint: "发起与管理群视频会议" },
  { key: "can_promote_members", label: "添加新管理员", hint: "提升其他成员为管理员" },
  { key: "can_manage_chat", label: "管理聊天", hint: "默认管理员基础权限" },
];

/** 仿真屏编排组件的公开 props 契约。 */
export type TgAppSimulatorProps = {
  config: BotMenuConfig;
  botName: string;
  botUsername: string | null;
  selectedBotId: string;
  groups: AppSimGroup[];
  activeChatId: string | null;
  memberCount: string;
  systemNote?: string;
  templateVars?: Partial<MenuTemplateVars>;
  promptMessage?: { id: number; text: string; hint?: string } | null;
  onUserSend?: (text: string) => Promise<{ ok: boolean; text: string; joined?: boolean }>;
  joinPhase?: "idle" | "awaiting_code" | "joined";
  onRequestJoin?: () => Promise<{ ok: boolean; message: string }>;
  view: "group" | "private";
  onSelectGroup: (chatId: string) => void;
  /** 移动端从聊天区返回列表（桌面端双栏常驻不需要） */
  onBackToList?: () => void;
  onSyncGroups: () => void;
  syncing: boolean;
  /** 一键部署：父组件调用 deploy API，返回校验结果（stage/guide 由部署面板展示） */
  onDeployGroup: (chatId: string) => Promise<{
    ok: boolean;
    message: string;
    stage?: string;
    guide?: string[];
    invite_link?: string | null;
    chat_title?: string | null;
    reused?: boolean;
    chat_id?: string | null;
    migrated_from_chat_id?: string | null;
  } | null>;
  deployingChatId: string | null;
  /** 从列表/加群确认面板发起模拟加群申请（父组件创建验证会话并切换视图） */
  onSimulateJoinForGroup: (chatId: string) => Promise<{ ok: boolean; message: string }>;
  /** 群组设置保存成功后由父组件刷新列表数据（router.refresh + realGroups 重载） */
  onSettingsSaved: () => void;
  /** v2.0.15 新建群组流程的机器人列表（已有机器人，替代 APP「选择用户」） */
  bots: NewGroupBot[];
  /** v2.1.2 真实群消息（父组件按 bot 权限视角拉取的 chat_messages 台账） */
  realMessages?: RealChatMessage[];
  /** 真实消息加载状态（v2.1.3 起父组件只在展现时获取，无轮询） */
  realMessagesState?: { loading: boolean; fetchedAt: string | null; error: string | null };
  /** v2.1.3 手动刷新真实群消息（聊天区同步胶囊刷新按钮，绕过展现去重强制拉取） */
  onRefreshRealMessages?: () => void | Promise<void>;
};
