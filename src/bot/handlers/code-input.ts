import { InlineKeyboard } from "grammy";
import type { BotContext } from "../context";
import { getPendingCodeContext } from "@/database/operations";
import {
  evaluateSubmittedCode,
  type CodeCheckResult,
} from "@/services/verification-flow";
import { kickUnverifiedMember } from "@/services/approval";

/** 网络波动、服务端即将重试时立即私聊发送给用户的提示文案 */
const NETWORK_RETRY_NOTICE = "🌐 网络波动，正在重试...";

/**
 * 验证失效（尝试次数用尽）后回复「申请加群」按钮：
 * 生成入群申请链接（creates_join_request，与「一键部署」同一参数），
 * 用户点击按钮 → 打开群资料 → 申请加入 → 触发新的 chat_join_request → 重新走完整验证流程。
 *
 * 与「一键部署」按钮文案/链接语义保持一致；发送失败由 grammY bot.catch 全局兜底并记录，
 * 不影响已发出的失效提示文案。
 */
async function sendReapplyJoinButton(
  ctx: BotContext,
  userId: number,
  chatId: string,
): Promise<void> {
  const invite = await ctx.api.createChatInviteLink(chatId, {
    creates_join_request: true,
    name: "TGuard 加群验证",
  });
  await ctx.api.sendMessage(
    userId,
    "本次验证已失效，请点击下方按钮重新申请加群。",
    {
      reply_markup: new InlineKeyboard().url("🔄 申请加群", invite.invite_link),
    },
  );
  console.log(`Re-apply join button sent to user ${userId} for chat ${chatId}`);
}

/**
 * 验证码校验入口（真实 Telegram 路径）。
 * 核心校验管道位于 @/services/verification-flow.ts 的 evaluateSubmittedCode，
 * 与管理后台「机器人测试」仿真屏共用同一实现，保证行为与文案完全一致。
 *
 * 由两条路径触发：
 * 1. stateless-question 回调（隐私模式兼容：用户回复验证问题消息）
 * 2. handleCodeInput（宽松模式：任意文本消息触发）
 *
 * 隐私红线：所有结果类消息（重试提示/成功/失败/失效文案）一律私聊发送
 * （受理 bot 自己的 ctx.api.sendMessage(from.id, …)），群组内绝不出现验证消息。
 *
 * v1.1.4：返回校验结果供 stateless-question 路径判断 no_pending
 * （回复的是验证提示但会话已失效/已完成时必须给出明确反馈，不静默吞掉）。
 */
export async function processCodeAnswer(
  ctx: BotContext,
  codeText: string,
  preloaded?: Awaited<ReturnType<typeof getPendingCodeContext>>,
): Promise<CodeCheckResult | null> {
  const from = ctx.from;
  if (!from || from.is_bot || !codeText.trim()) {
    return null;
  }

  const result = await evaluateSubmittedCode({
    userId: BigInt(from.id),
    username: from.username ?? null,
    code: codeText,
    preloaded: preloaded ?? undefined,
    onNetworkRetry: async () => {
      await ctx.api.sendMessage(from.id, NETWORK_RETRY_NOTICE);
    },
  });

  // no_pending：非验证会话中的普通消息，交还后续中间件处理。
  // stateless-question 路径（回复验证提示）据此走「失效反馈」分支，见 verification-question.ts
  if (result.outcome === "no_pending" && !result.replyText) {
    return result;
  }

  if (result.outcome === "failed_expired") {
    console.warn(
      `Code verification failed and expired for user ${from.id}: ${result.reason ?? ""}`,
    );
  } else if (result.outcome === "success") {
    console.log(`Code verification succeeded for user ${from.id}`);
  } else if (result.outcome === "network_error") {
    console.warn(
      `Code verification hit network error for user ${from.id} (attempts NOT consumed): ${result.reason ?? ""}`,
    );
  }

  // 验证结果文案一律私聊发送（不用 ctx.reply，避免消息落到输码所在的群聊）
  await ctx.api.sendMessage(from.id, result.replyText);

  // 验证失效：紧随失效文案发送「申请加群」按钮（入群申请链接），
  // 把用户输入框的 force_reply 状态替换为可重新发起加群申请的按钮
  if (result.outcome === "failed_expired" && result.reapplyChatId) {
    if (result.joinRequestType === "direct") {
      // 直连入群路径：用户仍物理在群内，验证失败必须踢出（ban+unban，可重新申请），
      // 否则普通邀请链接就能绕过验证 —— 私聊告知结果并回复「申请加群」按钮（群内零消息）
      let kicked = false;
      try {
        kicked = await kickUnverifiedMember(
          BigInt(result.reapplyChatId),
          BigInt(from.id),
        );
      } catch (error) {
        console.error(`Failed to kick unverified direct-join user ${from.id}:`, error);
      }
      const invite = await ctx.api.createChatInviteLink(result.reapplyChatId, {
        creates_join_request: true,
        name: "TGuard 加群验证",
      });
      await ctx.api.sendMessage(
        from.id,
        kicked
          ? "本次验证已失效，你已被移出群组。请点击下方按钮重新申请加群。"
          : "本次验证已失效，请点击下方按钮重新申请加群。",
        {
          reply_markup: new InlineKeyboard().url("🔄 申请加群", invite.invite_link),
        },
      );
      console.log(
        `Direct-join re-apply button sent to user ${from.id} for chat ${result.reapplyChatId} (kicked=${kicked})`,
      );
    } else {
      await sendReapplyJoinButton(ctx, from.id, result.reapplyChatId);
    }
  }

  return result;
}

/**
 * 全局文本消息入口（宽松兜底）。
 *
 * 隐私模式行为（group_settings.privacy_mode，默认开启）：
 * - 群聊开启：机器人遵循 Telegram 隐私模式，仅处理「回复机器人消息」的验证码输入
 *   （force_reply 的验证问题或手动回复），其余群内消息一律忽略——
 *   无需关闭隐私模式即可完成验证（stateless-question 语义）。
 * - 关闭：宽松模式，任意私聊/群聊文本消息都会触发验证码校验
 *   （要求机器人已通过 BotFather 关闭隐私模式或具备群管理员权限）。
 *
 * v1.1.4 修复「私聊第二次输码无响应」：Telegram 隐私模式只作用于群聊，
 * 私聊消息 bot 本来就全部可达 —— 私聊里的任何文本（无需手动回复验证消息）
 * 都直接进入验证码校验，不再被「必须回复」条件静默忽略。
 */
export async function handleCodeInput(
  ctx: BotContext,
  next: () => Promise<void>,
): Promise<void> {
  const from = ctx.from;
  const text = ctx.message?.text;
  if (!from || from.is_bot || !text) {
    await next();
    return;
  }
  if (text.startsWith("/")) {
    await next();
    return;
  }

  const pending = await getPendingCodeContext(BigInt(from.id));
  if (!pending) {
    await next();
    return;
  }

  const privacyMode = pending.settings?.privacyMode ?? true;
  if (privacyMode && ctx.chat?.type !== "private") {
    // 仅群聊需要「回复机器人消息」条件：隐私模式下机器人收不到群内普通消息，
    // 收到的消息若也不是回复机器人的（双保险）则忽略。
    // 私聊不受隐私模式影响：不设任何回复条件，直接进入校验（v1.1.4）。
    const replyTo = ctx.message?.reply_to_message;
    const isReplyToBot = Boolean(
      replyTo?.from && ctx.me && replyTo.from.id === ctx.me.id,
    );
    if (!isReplyToBot) {
      await next();
      return;
    }
  }

  await processCodeAnswer(ctx, text, pending);
}
