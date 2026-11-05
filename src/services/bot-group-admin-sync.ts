/**
 * 群组机器人管理员真实同步管道（全局唯一实现）。
 *
 * 消费方（必须同源）：
 * - 「群组管理 → 机器人管理员」弹窗：bots/actions.ts setBotGroupAdminAction / removeBotGroupAdminAction
 * - 仿真屏「机器人权限配置」页（图3）：/api/admin/bots/testing/bot-admins PUT
 *
 * 核心语义（与 Telegram 官方限制对齐）：
 * - 机器人无法提升自己（promoteChatMember 400 can't promote self）、也无法修改自己的权限
 *   → 非管理员时通过其它「提升者」bot（can_promote_members）跨 bot 提升；
 * - 已是管理员时以 getChatMember 实际权限为权威数据源落库（勾选仅作参考）；
 * - 全链路轻量 API 客户端（botByToken）+ getMe 缓存 + withTelegramTimeout，
 *   绝不经 acquireMenuBot 启动轮询 runtime（无效 token 时启动链路卡死 20s+）。
 */
import { Bot } from "grammy";
import { listBots } from "@/database/operations";
import {
  BOT_ADMIN_RIGHT_KEYS,
  BOT_ADMIN_RIGHT_LABELS,
  type BotAdminRights,
} from "@/services/bot-admin-rights";
import { botByToken, getMeCached, withTelegramTimeout } from "@/services/telegram-sync";

/** 权限键 → 中文标签拼接（保存结果提示用） */
export function formatRights(rights: BotAdminRights): string {
  const enabled = BOT_ADMIN_RIGHT_KEYS.filter((key) => rights[key]);
  return enabled.length > 0 ? enabled.map((key) => BOT_ADMIN_RIGHT_LABELS[key]).join("、") : "无具体权限";
}

/** 从 getChatMember 的 administrator 状态读取实际权限（真实同步的权威数据源） */
export function actualRightsFromMember(member: {
  can_change_info?: boolean;
  can_delete_messages?: boolean;
  can_invite_users?: boolean;
  can_restrict_members?: boolean;
  can_pin_messages?: boolean;
  can_manage_video_chats?: boolean;
  can_promote_members?: boolean;
}): BotAdminRights {
  return {
    can_manage_chat: true,
    can_change_info: member.can_change_info === true,
    can_delete_messages: member.can_delete_messages === true,
    can_invite_users: member.can_invite_users === true,
    can_restrict_members: member.can_restrict_members === true,
    can_pin_messages: member.can_pin_messages === true,
    can_manage_video_chats: member.can_manage_video_chats === true,
    can_promote_members: member.can_promote_members === true,
  };
}

/**
 * 查找「提升者」机器人：其它接入 bot 中在本群为管理员且拥有「添加新管理员」权限的实例。
 * Telegram 官方限制：机器人无法提升自己、也无法修改自己的权限 ——
 * 跨 bot 提升是 Bot API 唯一合法的自动化路径。
 */
export async function findPromoterBot(
  chatId: number,
  excludeBotId: bigint,
): Promise<{ api: Bot["api"]; username: string | null } | null> {
  let rows: Awaited<ReturnType<typeof listBots>> = [];
  try {
    rows = await listBots();
  } catch {
    return null;
  }
  for (const row of rows) {
    if (Number(row.id) === Number(excludeBotId) || !row.enabled || !row.token.trim()) continue;
    try {
      const api = botByToken(row.token).api;
      const me = await withTelegramTimeout(getMeCached(api, row.token));
      const member = await withTelegramTimeout(api.getChatMember(chatId, me.id));
      if (member.status === "administrator" && member.can_promote_members === true) {
        return { api, username: me.username ?? null };
      }
    } catch {
      continue;
    }
  }
  return null;
}

export const PROMOTE_SELF_GUIDE =
  "Telegram 官方限制：机器人无法提升自己为管理员（can't promote self），也无法修改自己的权限。" +
  "请打开 Telegram 客户端：群设置 → 管理员 → 添加管理员 → 选择该机器人并勾选权限 → 保存；" +
  "完成后回到本弹窗重新点击「保存」，系统将自动读取并同步 Telegram 实际权限。";

/** v1.2.0：401（Token 失效）替代原始 GrammyError 描述的可读中文 */
export const INVALID_TOKEN_GUIDE =
  "该机器人的 Bot Token 无效或已被撤销（Telegram 401 Unauthorized）：请到 @BotFather → /mybots → API Token 查看当前 Token，若已撤销请重新生成并在「机器人管理」中更新保存，再回本弹窗重新保存。";
