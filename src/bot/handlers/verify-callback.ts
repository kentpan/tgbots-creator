import type { BotContext } from "../context";
import {
  getGroupSettings,
  getVerificationSession,
  isSessionExpired,
} from "@/database/operations";
import { evaluateSubmittedCode, loadPendingContextByToken } from "@/services/verification-flow";
import {
  buildGroupPromptHTML,
  buildGroupPromptKeyboard,
  buildGroupRetryHTML,
  refreshGroupPromptAttempts,
} from "@/services/group-verification";

/**
 * 群内 4 选 1 验证按钮（v2.1.0，自动验证码方式的群内形态）。
 *
 * callback_data = `vg:<token>:<index>`：
 * - 群友只能看到 4 个候选数字按钮，看不到谁点了哪个、也看不到正确码；
 * - 机器人按 index 取出会话里的候选码提交校验（与私聊输码完全同一套判定管道
 *   evaluateSubmittedCode：同一尝试次数、同一成功/失败文案、同一失效收口）；
 * - 点错不产生任何群消息（只把剩余次数刷回提示消息里），点对则删除提示 + 解禁 + 群内欢迎。
 *
 * 安全约束：只接受会话所属用户本人的点击（session.userId === ctx.from.id），
 * 其他人的点击一律 answerCallbackQuery 提示「这不是你的验证」，不消耗尝试次数。
 */

const CALLBACK_PREFIX = "vg:";

/** Telegram answerCallbackQuery 文本上限 200 字符，超长直接截断（避免 400 静默失败） */
function clip(text: string, max = 190): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

export async function handleVerificationCallback(
  ctx: BotContext,
  next: () => Promise<void>,
): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith(CALLBACK_PREFIX)) {
    await next();
    return;
  }

  const parts = data.split(":");
  const token = parts[1] ?? "";
  const indexRaw = parts[2] ?? "";
  const index = Number(indexRaw);

  const answer = async (text: string, alert = false): Promise<void> => {
    try {
      await ctx.answerCallbackQuery({ text: clip(text), show_alert: alert });
    } catch (error) {
      console.warn(
        "[group-verify] answerCallbackQuery 失败:",
        error instanceof Error ? error.message : error,
      );
    }
  };

  if (!token || !Number.isInteger(index) || index < 0) {
    await answer("验证按钮已失效，请重新申请加群");
    return;
  }

  const session = await getVerificationSession(token);
  if (!session || isSessionExpired(session) || session.captchaCompleted) {
    await answer("本次验证已结束，请重新申请加群");
    return;
  }

  // 只有会话本人能提交：其他人点击不消耗尝试次数、不产生任何群消息
  if (!ctx.from || BigInt(ctx.from.id) !== session.userId) {
    await answer("这不是你的验证，请点击你自己收到的验证消息", true);
    return;
  }

  const optionCode = session.optionCodes?.[index];
  if (!optionCode) {
    await answer("验证选项已失效，请重新申请加群");
    return;
  }

  const pending = await loadPendingContextByToken(token);
  const result = await evaluateSubmittedCode({
    userId: session.userId,
    username: ctx.from.username ?? null,
    code: optionCode,
    preloaded: pending,
  });

  if (result.outcome === "success") {
    // completeGroupJoinVerification 已解禁 + 删除群内提示 + 群内欢迎
    await answer(result.replyText || "✅ 验证通过，欢迎加入！");
    console.log(`[group-verify] 群内按钮验证通过: user=${session.userId} chat=${session.chatId}`);
    return;
  }

  if (result.outcome === "failed_expired") {
    // failGroupVerification 已删除提示 + 群内告知 + 踢出
    await answer("验证失败，尝试次数已用尽，你已被移出群组", true);
    return;
  }

  if (result.outcome === "failed_retry") {
    await answer(`❌ 错误，剩余 ${result.remaining ?? 0} 次机会`);
    // 刷新群内提示：保留原提示 + 失败原因 + 剩余次数（点哪个只有机器人知道）
    const settings = await getGroupSettings(session.chatId);
    const baseHtml = buildGroupPromptHTML({
      chatId: session.chatId,
      userId: session.userId,
      displayName: "你",
      chatTitle: settings?.chatTitle ?? null,
      token,
      method: session.method,
      expiresAt: session.expiresAt,
      optionCodes: session.optionCodes,
    });
    await refreshGroupPromptAttempts({
      chatId: session.chatId,
      userId: session.userId,
      messageId: session.groupMessageId,
      html: buildGroupRetryHTML({
        baseHtml,
        failureText: settings?.failureText ?? "❌ 验证码错误，请重试。",
        reason: result.reason ?? "",
        remaining: result.remaining ?? 0,
      }),
      keyboard: buildGroupPromptKeyboard({
        token,
        method: session.method,
        optionCodes: session.optionCodes,
        verifyUrl: null,
      }),
    });
    return;
  }

  if (result.outcome === "network_error") {
    await answer(result.reason ? `网络异常：${result.reason}` : "网络异常，请稍后重试", true);
    return;
  }

  await answer(result.replyText || "验证已结束，请重新申请加群");
}
