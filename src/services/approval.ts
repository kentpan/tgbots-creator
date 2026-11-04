import { Bot, GrammyError, InlineKeyboard } from "grammy";
import { config } from "@/config/settings";
import { telegramBotClientOptions } from "@/lib/telegram/transport";
import {
  getActiveBotForChat,
  getJoinRequestByToken,
  approveJoinRequest,
} from "@/database/operations";
import { escapeMarkdownV2 } from "@/utils/markdown";

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
): Promise<void> {
  const bot = await resolveBotForChat("verificationExpiredNotice", chatId, userId);
  const invite = await bot.api.createChatInviteLink(Number(chatId), {
    creates_join_request: true,
    name: "TGuard 加群验证",
  });
  const actionText =
    requestType === "direct"
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
