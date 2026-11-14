import { StatelessQuestion } from "@grammyjs/stateless-question";
import { InlineKeyboard } from "grammy";
import type { BotContext } from "./context";
import { processCodeAnswer } from "./handlers/code-input";
import { getLatestVerificationContext } from "@/database/operations";

/**
 * 加群验证的无状态问题（stateless-question）。
 *
 * 兼容历史验证消息的无状态问题（legacy reply path）。当前申请制加群验证的主交互
 * 是私聊输入框直接发送验证码，由 handleCodeInput 按 ctx.from.id 查找会话；不再
 * 依赖 force_reply 或隐形后缀。此中间件只保留给仍在回复旧提示消息的用户。
 *
 * 问题的状态完全编码在消息后缀中（无状态），机器人重启不会丢失验证上下文；
 * 会话的尝试次数与过期时间仍由数据库 verification_sessions 管理。
 */
export const VERIFICATION_QUESTION_ID = "tgcode";

/**
 * v2.1.5：群聊内的失效/已完成反馈自动清理（60 秒后删除，留足点按「申请加群」按钮
 * 的时间）。私聊反馈永久保留。删除失败（机器人无「删除消息」权限）仅记录不抛出。
 */
const GROUP_FEEDBACK_AUTO_DELETE_MS = 60000;

async function replyWithGroupAutoCleanup(
  ctx: BotContext,
  text: string,
  extra?: Parameters<BotContext["reply"]>[1],
): Promise<void> {
  const inGroup = Boolean(ctx.chat && ctx.chat.type !== "private");
  const sent = await ctx.reply(text, extra);
  if (inGroup && sent?.message_id && ctx.chat) {
    const chatId = ctx.chat.id;
    const messageId = sent.message_id;
    setTimeout(() => {
      void ctx.api
        .deleteMessage(chatId, messageId)
        .catch((error: unknown) => {
          console.warn(
            `Failed to delete group stale-reply feedback ${messageId} in chat ${chatId}:`,
            error,
          );
        });
    }, GROUP_FEEDBACK_AUTO_DELETE_MS);
  }
}

export const codeQuestion = new StatelessQuestion<BotContext>(
  VERIFICATION_QUESTION_ID,
  async (ctx) => {
    const result = await processCodeAnswer(ctx, ctx.message?.text ?? "");

    // v1.1.4：回复的是本 bot 的验证提示消息，但已没有待验证会话——
    // 绝不静默吞掉，按最近一次会话状态给出明确反馈：
    // - 已完成（验证通过/申请已批准）→ 告知无需重复验证
    // - 已失效（超时清理/尝试用尽/被拒）→ 告知失效并附「申请加群」按钮重新发起
    if (result && result.outcome === "no_pending" && !result.replyText) {
      if (!ctx.from) {
        return;
      }
      const latest = await getLatestVerificationContext(BigInt(ctx.from.id));
      if (!latest) {
        return;
      }
      if (
        latest.session.captchaCompleted ||
        latest.joinRequest.status === "approved"
      ) {
        await replyWithGroupAutoCleanup(ctx, "✅ 你已完成验证，无需重复验证。");
        return;
      }
      if (latest.joinRequest.chatId !== 0n) {
        const invite = await ctx.api.createChatInviteLink(
          Number(latest.joinRequest.chatId),
          {
            creates_join_request: true,
            name: "TGuard 加群验证",
          },
        );
        await replyWithGroupAutoCleanup(
          ctx,
          "❌ 本次验证已失效，请点击下方按钮重新申请加群。",
          {
            reply_markup: new InlineKeyboard().url(
              "🔄 申请加群",
              invite.invite_link,
            ),
          },
        );
      } else {
        await replyWithGroupAutoCleanup(ctx, "❌ 本次验证已失效，请重新申请加群。");
      }
      console.log(
        `Stale verification prompt reply from user ${ctx.from.id}: ` +
          `session ${latest.session.token.slice(0, 8)}..., joinRequest=${latest.joinRequest.status}`,
      );
    }
  },
);
