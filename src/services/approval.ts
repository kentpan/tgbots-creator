import { Bot, GrammyError, InlineKeyboard } from "grammy";
import { config } from "@/config/settings";
import { telegramBotClientOptions } from "@/lib/telegram/transport";
import {
  getActiveBotForChat,
  getJoinRequestByToken,
  approveJoinRequest,
  getVerificationSession,
  getGroupSettings,
} from "@/database/operations";
import { escapeMarkdownV2 } from "@/utils/markdown";
import { htmlEscape, userMentionHTML } from "@/utils/html";

const TELEGRAM_ERRORS: Record<string, string> = {
  user_not_found: "用户不存在",
  chat_not_found: "群组不存在",
  request_not_found: "加群申请在Telegram中不存在",
  bot_not_member: "机器人不是群组成员",
  not_enough_rights: "机器人权限不足",
  deactivated: "用户已注销",
};

export class ApprovalResult {
  constructor(
    public readonly success: boolean,
    public readonly error: string | null = null,
  ) {}
}

const globalForBot = globalThis as unknown as { tguardBot?: Bot };

/** 调用场景上下文：主 bot token 缺失时抛错必须携带的定位信息 */
export interface BotResolutionContext {
  scenario: string;
  chatId: bigint;
  userId: bigint;
}

export function getBot(context?: BotResolutionContext): Bot {
  const token = config.bot.token.trim();
  if (!token) {
    const where = context
      ? `；场景=${context.scenario}，chatId=${context.chatId}，userId=${context.userId}`
      : "";
    throw new Error(
      `主 bot token 未配置（config.toml [bot].token 为空），无法执行 Telegram 操作${where}`,
    );
  }
  if (!globalForBot.tguardBot) {
    globalForBot.tguardBot = new Bot(token, telegramBotClientOptions());
  }
  return globalForBot.tguardBot;
}

/**
 * 按群解析受理 bot 实例（FIX-B 跨 token 审批缺陷修复）：
 * 用户经菜单 bot（bots 表，如 @groups_dog_bot）申请加群时，加群审批/拒绝/私聊欢迎语
 * 必须由「该群绑定的启用 bot」执行；此前固定用主 bot（config.toml token），主 bot 无 token
 * 或不在群内时审批永远失败。
 *
 * 解析顺序：
 * 1. group_bot_admins × bots 联查该群绑定的启用 bot（getActiveBotForChat，updated_time 最新），
 *    Bot 实例复用 telegram-sync 的 botByToken（Map<token, Bot> 缓存，仅调用 .api，不启动轮询）；
 * 2. 无绑定 / token 为空 → 回落主 bot getBot()（保持旧行为兼容）；
 * 3. 主 bot 也无 token → getBot() 抛出带场景/chatId/userId 的错误（禁止吞错、禁止静默跳过）。
 */
async function resolveBotForChat(scenario: string, chatId: bigint, userId: bigint): Promise<Bot> {
  const binding = await getActiveBotForChat(chatId);
  const boundToken = binding?.token.trim() ?? "";
  if (binding && boundToken) {
    const { botByToken } = await import("./telegram-sync");
    return botByToken(boundToken);
  }
  if (binding) {
    console.warn(
      `[approval] chat ${chatId} 的受理 bot #${String(binding.botId)} token 为空，回落主 bot（场景=${scenario}）`,
    );
  }
  return getBot({ scenario, chatId, userId });
}

export async function closeBot(): Promise<void> {
  if (globalForBot.tguardBot) {
    globalForBot.tguardBot = undefined;
  }
}

export function describeTelegramError(error: unknown): string | null {
  let message = "";
  if (error instanceof GrammyError) {
    message = error.description.toLowerCase();
  } else if (error instanceof Error) {
    message = error.message.toLowerCase();
  }
  for (const [fragment, text] of Object.entries(TELEGRAM_ERRORS)) {
    if (message.includes(fragment)) {
      return text;
    }
  }
  return null;
}

export async function dismissJoinRequest(chatId: bigint, userId: bigint): Promise<boolean> {
  try {
    const bot = await resolveBotForChat("dismissJoinRequest", chatId, userId);
    await bot.api.declineChatJoinRequest(Number(chatId), Number(userId));
    console.log(`Dismissed join request: user ${userId} for chat ${chatId}`);
    return true;
  } catch (error) {
    if (error instanceof GrammyError && error.error_code === 400) {
      const reason = describeTelegramError(error) ?? "Telegram API错误";
      console.warn(`Skip dismiss for user ${userId} (chat ${chatId}): ${reason} (${error.description})`);
      return false;
    }
    const reason = describeTelegramError(error) ?? "Telegram API错误";
    console.warn(`Skip dismiss for user ${userId} (chat ${chatId}): ${reason}`);
    return false;
  }
}

/**
 * 踢出未验证成员（v1.1.3，直连入群防线）：ban + unban = 仅移出群组（不封禁），
 * 用户之后仍可通过入群申请链接重新申请。需要机器人拥有「封禁用户」管理员权限。
 */
export async function kickUnverifiedMember(chatId: bigint, userId: bigint): Promise<boolean> {
  try {
    const bot = await resolveBotForChat("kickUnverifiedMember", chatId, userId);
    await bot.api.banChatMember(Number(chatId), Number(userId));
    await bot.api.unbanChatMember(Number(chatId), Number(userId), { only_if_banned: true });
    console.log(`Kicked unverified member: user ${userId} from chat ${chatId}`);
    return true;
  } catch (error) {
    const reason = describeTelegramError(error) ?? "Telegram API错误";
    console.warn(`Failed to kick unverified user ${userId} (chat ${chatId}): ${reason}`);
    return false;
  }
}

/**
 * 验证超时通知（v1.1.4）：清理任务把过期会话处理掉（拒绝申请/移出群组）后，
 * 私聊告知用户结果并附「申请加群」按钮（creates_join_request，与验证失效同款），
 * 用户点击即可重新发起加群申请 → 全新验证流程。
 *
 * 与失效文案同一交互形态（见 code-input.ts failed_expired 分支）；
 * 私聊发送失败（用户未启动 bot / 已拉黑）直接向上抛出，由调用方按目标逐条完整记录，
 * 绝不静默吞错，也不影响其他过期目标的处理。
 */
export async function notifyVerificationExpired(
  chatId: bigint,
  userId: bigint,
  requestType: string,
  groupActionOk: boolean,
  /** v2.0.5 群内验证模式：用户在群内已被批准入群，超时动作是「移出群组」而非「拒绝申请」 */
  groupChannel = false,
): Promise<void> {
  const bot = await resolveBotForChat("verificationExpiredNotice", chatId, userId);
  const invite = await bot.api.createChatInviteLink(Number(chatId), {
    creates_join_request: true,
    name: "TGuard 加群验证",
  });
  const actionText = groupChannel
    ? groupActionOk
      ? "你已被移出群组"
      : "你的入群资格已失效"
    : requestType === "direct"
      ? groupActionOk
        ? "你已被移出群组"
        : "你的入群资格已失效"
      : groupActionOk
        ? "你的加群申请已被拒绝"
        : "你的入群申请已失效";
  await bot.api.sendMessage(Number(userId), `⏰ 验证超时：超时未完成验证，${actionText}。\n请点击下方按钮重新申请加群。`, {
    reply_markup: new InlineKeyboard().url("🔄 申请加群", invite.invite_link),
  });
  console.log(`Verification timeout notice sent to user ${userId} for chat ${chatId}`);
}

async function sendWelcomeMessage(bot: Bot, chatId: bigint, userId: bigint): Promise<void> {
  try {
    const chatInfo = await bot.api.getChat(Number(chatId));
    const escapedTitle = escapeMarkdownV2(
      "title" in chatInfo && chatInfo.title ? chatInfo.title : "群组",
    );
    await bot.api.sendMessage(Number(userId), `🎉 *验证成功\\!*\n\n您已成功加入 *${escapedTitle}*，欢迎\\!`, {
      parse_mode: "MarkdownV2",
    });
  } catch (error) {
    console.warn(`Could not send welcome message to ${userId}:`, error);
  }
}

export async function autoApproveUser(verificationToken: string): Promise<ApprovalResult> {
  try {
    const joinRequest = await getJoinRequestByToken(verificationToken);
    if (!joinRequest) {
      console.error(`Join request not found for token: ${verificationToken.slice(0, 8)}...`);
      return new ApprovalResult(false, "加群申请不存在");
    }

    if (joinRequest.status !== "pending") {
      console.warn(`Join request already processed: ${joinRequest.status}`);
      return new ApprovalResult(false, `申请已处理：${joinRequest.status}`);
    }

    if (joinRequest.chatId === 0n) {
      console.warn("Cannot approve request with chat_id=0 (API request without chat)");
      return new ApprovalResult(false, "无效的群组ID");
    }

    const bot = await resolveBotForChat("autoApproveUser", joinRequest.chatId, joinRequest.userId);
    try {
      await bot.api.approveChatJoinRequest(Number(joinRequest.chatId), Number(joinRequest.userId));
    } catch (error) {
      if (error instanceof GrammyError && error.error_code === 400) {
        const reason = describeTelegramError(error);
        console.warn(
          `Telegram rejected approval of user ${joinRequest.userId} for chat ${joinRequest.chatId}: ${error.description}`,
        );
        return new ApprovalResult(false, reason ?? `Telegram API错误：${error.description}`);
      }
      throw error;
    }

    const updated = await approveJoinRequest(verificationToken);
    if (!updated) {
      console.error(`Failed to update database for token: ${verificationToken.slice(0, 8)}...`);
      return new ApprovalResult(false, "数据库更新失败");
    }

    console.log(
      `Successfully auto-approved user ${joinRequest.userId} for chat ${joinRequest.chatId}`,
    );

    if (joinRequest.requestType === "telegram") {
      await sendWelcomeMessage(bot, joinRequest.chatId, joinRequest.userId);
    }

    return new ApprovalResult(true);
  } catch (error) {
    console.error("Unexpected error during auto-approval:", error);
    return new ApprovalResult(false, `自动审批失败：${String(error)}`);
  }
}

/**
 * 直连入群验证通过（v1.1.3）：用户已经物理在群内（普通链接/被拉入），
 * 无需也无法调用 approveChatJoinRequest，仅落库标记通过 + 私聊祝贺。
 */
export async function completeDirectJoinVerification(
  verificationToken: string,
): Promise<ApprovalResult> {
  try {
    const joinRequest = await getJoinRequestByToken(verificationToken);
    if (!joinRequest) {
      console.error(`Direct join request not found for token: ${verificationToken.slice(0, 8)}...`);
      return new ApprovalResult(false, "加群申请不存在");
    }
    if (joinRequest.status !== "pending") {
      console.warn(`Direct join request already processed: ${joinRequest.status}`);
      return new ApprovalResult(false, `申请已处理：${joinRequest.status}`);
    }

    // 私聊欢迎语须由该群绑定的受理 bot 发送；解析失败（主 bot 亦无 token）直接抛错，
    // 不做任何数据库写入（fail-fast，避免「库已批准但返回失败」的半完成状态）
    const bot =
      joinRequest.chatId !== 0n
        ? await resolveBotForChat("directJoinWelcome", joinRequest.chatId, joinRequest.userId)
        : null;

    const updated = await approveJoinRequest(verificationToken);
    if (!updated) {
      console.error(`Failed to update database for token: ${verificationToken.slice(0, 8)}...`);
      return new ApprovalResult(false, "数据库更新失败");
    }

    console.log(
      `Direct join verification completed: user ${joinRequest.userId} for chat ${joinRequest.chatId}`,
    );

    if (bot) {
      await sendWelcomeMessage(bot, joinRequest.chatId, joinRequest.userId);
    }

    return new ApprovalResult(true);
  } catch (error) {
    console.error("Unexpected error during direct-join completion:", error);
    return new ApprovalResult(false, `直连入群确认失败：${String(error)}`);
  }
}

/**
 * ======================= 群内验证模式（v2.0.5） =======================
 *
 * 验证渠道 = "group"（默认）时，验证全部在群内完成，输入内容其他成员不可见：
 * - 入群申请链接用户：bootstrap 阶段先批准入群申请（本函数组）→ 用户进群 → 禁言 →
 *   群内验证消息（captcha/code_api = 网页按钮输码；code_self = 4 选 1 按钮）；
 * - 验证通过：completeGroupVerification —— 解禁 + 删除群内验证消息 + 群内欢迎；
 * - 失败/超时：踢出（ban+unban）+ 删除群内验证消息 + 群内超时提示。
 *
 * 群内绝不出现「回复本消息输码」类明文输入通道（code-input.ts 已硬性拦截群内输码），
 * 用户输入只发生在网页（/verify）或 callback 按钮里，其他成员全程不可见。
 */

/** 机器人标准成员发言权限集合（解除禁言时恢复，不越权提升管理员敏感权限） */
const MEMBER_SEND_PERMISSIONS = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
} as const;

/** 禁言权限集合（验证通过前全部关闭） */
const MUTED_PERMISSIONS = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
} as const;

/**
 * 批准 Telegram 侧加群申请（仅 API 动作，不落库）。
 * 群内验证模式 bootstrap 专用：入群申请先批准让用户进群，验证随后在群内完成，
 * join_requests.status 保持 pending 直到验证通过（超时清理依赖该语义）。
 */
export async function approveTelegramJoinRequest(
  chatId: bigint,
  userId: bigint,
): Promise<ApprovalResult> {
  try {
    const bot = await resolveBotForChat("approveTelegramJoinRequest", chatId, userId);
    await bot.api.approveChatJoinRequest(Number(chatId), Number(userId));
    console.log(`Approved Telegram join request: user ${userId} for chat ${chatId}`);
    return new ApprovalResult(true);
  } catch (error) {
    if (error instanceof GrammyError && error.error_code === 400) {
      const reason = describeTelegramError(error);
      console.warn(
        `Telegram rejected join request approval of user ${userId} for chat ${chatId}: ${error.description}`,
      );
      return new ApprovalResult(false, reason ?? `Telegram API错误：${error.description}`);
    }
    const reason = describeTelegramError(error) ?? "Telegram API错误";
    console.warn(`Failed to approve join request for user ${userId} (chat ${chatId}): ${reason}`);
    return new ApprovalResult(false, reason);
  }
}

/**
 * 禁言未验证成员（群内验证 bootstrap）：全部发言权限关闭，验证通过时解除。
 * untilDate 兜底上限：即使验证成功路径全部失效，禁言也会到期自动解除（不永久禁言）。
 * 机器人无「限制成员」权限时返回 false（不阻塞验证流程，超时/失败仍会尝试踢出）。
 */
export async function muteUnverifiedMember(
  chatId: bigint,
  userId: bigint,
  untilDate: Date,
): Promise<boolean> {
  try {
    const bot = await resolveBotForChat("muteUnverifiedMember", chatId, userId);
    // until_date 硬上限 366 天（Telegram 约束），下限 30 秒（Telegram 约束最短 30s）
    const untilSeconds = Math.min(
      Math.max(Math.floor(untilDate.getTime() / 1000), Math.floor(Date.now() / 1000) + 30),
      Math.floor(Date.now() / 1000) + 366 * 24 * 60 * 60,
    );
    await bot.api.restrictChatMember(
      Number(chatId),
      Number(userId),
      { ...MUTED_PERMISSIONS },
      { until_date: untilSeconds },
    );
    console.log(`Muted unverified member: user ${userId} in chat ${chatId}`);
    return true;
  } catch (error) {
    const reason = describeTelegramError(error) ?? "Telegram API错误";
    console.warn(`Failed to mute unverified user ${userId} (chat ${chatId}): ${reason}`);
    return false;
  }
}

/** 解除禁言（验证通过）：恢复标准成员发言权限；未禁言/无权限时静默成功 */
export async function unmuteGroupMember(chatId: bigint, userId: bigint): Promise<boolean> {
  try {
    const bot = await resolveBotForChat("unmuteGroupMember", chatId, userId);
    await bot.api.restrictChatMember(Number(chatId), Number(userId), { ...MEMBER_SEND_PERMISSIONS });
    console.log(`Unmuted member after verification: user ${userId} in chat ${chatId}`);
    return true;
  } catch (error) {
    const reason = describeTelegramError(error) ?? "Telegram API错误";
    console.warn(`Failed to unmute user ${userId} (chat ${chatId}): ${reason}`);
    return false;
  }
}

/** 删除指定会话的群内验证提示消息（验证通过/失败/超时后清理群内痕迹） */
export async function deleteSessionPromptMessage(token: string): Promise<boolean> {
  try {
    const session = await getVerificationSession(token);
    if (!session || !session.promptMessageId || session.chatId === 0n) {
      return false;
    }
    const bot = await resolveBotForChat("deleteSessionPromptMessage", session.chatId, session.userId);
    await bot.api.deleteMessage(Number(session.chatId), session.promptMessageId);
    return true;
  } catch (error) {
    console.warn(`Failed to delete group verification prompt for token ${token.slice(0, 8)}...:`, error);
    return false;
  }
}

/** 群内 HTML 通知（best effort，发送失败仅记录，绝不影响主流程） */
async function sendGroupNoticeHTML(bot: Bot, chatId: bigint, html: string): Promise<boolean> {
  try {
    await bot.api.sendMessage(Number(chatId), html, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    return true;
  } catch (error) {
    console.warn(`Failed to send group notice to chat ${chatId}:`, error);
    return false;
  }
}

/** 群内验证通过欢迎（mention + 群组可配置成功文案） */
export async function sendGroupWelcome(
  chatId: bigint,
  userId: bigint,
  username: string | null,
  firstName: string,
  lastName: string | null,
  successText: string,
): Promise<boolean> {
  try {
    const bot = await resolveBotForChat("sendGroupWelcome", chatId, userId);
    const mention = userMentionHTML({
      id: Number(userId),
      username,
      first_name: firstName,
      last_name: lastName,
    });
    return await sendGroupNoticeHTML(
      bot,
      chatId,
      `${mention} ${htmlEscape(successText)}`,
    );
  } catch (error) {
    console.warn(`Failed to send group welcome to user ${userId} (chat ${chatId}):`, error);
    return false;
  }
}

/** 群内验证超时提示（踢出前发送，被禁言成员仍可见群消息） */
export async function sendGroupTimeoutNotice(chatId: bigint, userId: bigint): Promise<boolean> {
  try {
    const bot = await resolveBotForChat("sendGroupTimeoutNotice", chatId, userId);
    const mention = userMentionHTML({ id: Number(userId), first_name: "该成员" });
    return await sendGroupNoticeHTML(
      bot,
      chatId,
      `⏰ ${mention} 未在规定时间内完成验证，已被移出群组。可重新申请加群。`,
    );
  } catch (error) {
    console.warn(`Failed to send group timeout notice (chat ${chatId}):`, error);
    return false;
  }
}

/**
 * 群内验证通过统一完成入口（v2.0.5）：
 * 1. join_requests 落库批准（pending → approved；已批准幂等跳过）；
 * 2. 解除禁言；
 * 3. 删除群内验证提示消息；
 * 4. 群内发送欢迎消息（mention + 可配置成功文案）。
 *
 * 适用于：入群申请链接用户（bootstrap 已在 Telegram 侧批准，无需再调
 * approveChatJoinRequest）与直连入群用户（无需审批动作）。
 */
export async function completeGroupVerification(
  verificationToken: string,
): Promise<ApprovalResult> {
  try {
    const joinRequest = await getJoinRequestByToken(verificationToken);
    if (!joinRequest) {
      console.error(`Join request not found for group completion: ${verificationToken.slice(0, 8)}...`);
      return new ApprovalResult(false, "加群申请不存在");
    }
    if (joinRequest.status === "rejected" || joinRequest.status === "expired") {
      console.warn(`Join request already terminal for group completion: ${joinRequest.status}`);
      return new ApprovalResult(false, `申请已处理：${joinRequest.status}`);
    }

    if (joinRequest.status === "pending") {
      const updated = await approveJoinRequest(verificationToken);
      if (!updated) {
        console.error(`Failed to update database for token: ${verificationToken.slice(0, 8)}...`);
        return new ApprovalResult(false, "数据库更新失败");
      }
    }

    if (joinRequest.chatId === 0n) {
      console.log(`Group verification completed for API request: ${verificationToken.slice(0, 8)}...`);
      return new ApprovalResult(true);
    }

    const bot = await resolveBotForChat(
      "completeGroupVerification",
      joinRequest.chatId,
      joinRequest.userId,
    );

    // Telegram 侧入群兜底：极少数场景（bootstrap 审批失败回落私聊验证的群渠道会话）
    // 用户尚未真正进群 —— 验证通过后在此补一次 approveChatJoinRequest
    if (joinRequest.requestType === "telegram") {
      try {
        const member = await bot.api.getChatMember(
          Number(joinRequest.chatId),
          Number(joinRequest.userId),
        );
        if (member.status === "left" || member.status === "kicked") {
          await bot.api.approveChatJoinRequest(
            Number(joinRequest.chatId),
            Number(joinRequest.userId),
          );
          console.log(
            `Late Telegram-side approval in group completion: user ${joinRequest.userId} chat ${joinRequest.chatId}`,
          );
        }
      } catch (membershipError) {
        console.warn(
          `Group completion: could not ensure Telegram-side membership for user ${joinRequest.userId} (chat ${joinRequest.chatId}):`,
          membershipError,
        );
      }
    }

    // 解禁 + 删除群内验证消息（均 best effort，失败不影响验证通过结论）
    await unmuteGroupMember(joinRequest.chatId, joinRequest.userId);
    const session = await getVerificationSession(verificationToken);
    if (session?.promptMessageId) {
      const deleted = await bot.api
        .deleteMessage(Number(joinRequest.chatId), session.promptMessageId)
        .then(() => true)
        .catch((error: unknown) => {
          console.warn(
            `Failed to delete verification prompt ${session.promptMessageId} in chat ${joinRequest.chatId}:`,
            error,
          );
          return false;
        });
      if (deleted) {
        console.log(
          `Group verification prompt deleted: chat ${joinRequest.chatId} message ${session.promptMessageId}`,
        );
      }
    }

    // 群内欢迎（mention + 可配置成功文案）
    const settings = await getGroupSettings(joinRequest.chatId);
    await sendGroupWelcome(
      joinRequest.chatId,
      joinRequest.userId,
      joinRequest.username,
      joinRequest.firstName,
      joinRequest.lastName,
      settings?.successText ?? "✅ 验证成功，欢迎加入！",
    );

    console.log(
      `Group verification completed: user ${joinRequest.userId} for chat ${joinRequest.chatId}`,
    );
    return new ApprovalResult(true);
  } catch (error) {
    console.error("Unexpected error during group completion:", error);
    return new ApprovalResult(false, `群内验证完成失败：${String(error)}`);
  }
}
