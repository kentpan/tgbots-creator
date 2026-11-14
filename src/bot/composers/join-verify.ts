import { Composer } from "grammy";
import type { BotContext } from "../context";
import { recordJoinRequestOnly, bootstrapJoinVerification, type JoinVerificationUser } from "../handlers/chat-member";
import { loadGroupSettingsForChat, resolveDesignatedBot, resolveJoinVerify } from "@/services/join-verify";
import { createJoinRequest, wasRecentlyApprovedForUserChat } from "@/database/operations";
import { generateVerificationToken } from "@/utils/crypto";
import { autoApproveUser } from "@/services/approval";

/**
 * 加群验证 Composer（grammy Composer 模块化，机器人实例按 botId 装配）：
 *
 * 多机器人竞态守卫（唯一实现）：
 * - 群组「自动审核机器人」未指定（join_verify_bot_id = NULL）→ 手动审核：
 *   所有机器人只落库加群申请记录（pending），「加群申请」页人工审批；
 * - 指定了其他机器人 → 当前机器人忽略事件（防止双响应/私聊窗口抢占/审批互踩）；
 * - 指定了当前机器人 → 走自动验证：私聊先验证后批准（approveChatJoinRequest
 *   静默放行 / 失败 3 次 declineChatJoinRequest）。
 */
export function createJoinVerifyComposer(botId: bigint): Composer<BotContext> {
  const composer = new Composer<BotContext>();

  composer.on("chat_join_request", async (ctx) => {
    const joinRequest = ctx.chatJoinRequest;
    if (!joinRequest) return;
    const user = joinRequest.from;
    const chat = joinRequest.chat;
    console.log(
      `[join-verify] update received bot=#${botId} chat=${chat.id} user=${user.id} ` +
        `user_chat_id=${joinRequest.user_chat_id} username=${user.username ?? "-"}`,
    );
    const settings = await loadGroupSettingsForChat(BigInt(chat.id));
    const role = resolveDesignatedBot(settings, botId);
    console.log(
      `[join-verify] routing chat=${chat.id} bot=#${botId} role=${role} ` +
        `designated=${settings?.joinVerifyBotId === null || settings?.joinVerifyBotId === undefined ? "manual" : `#${String(settings.joinVerifyBotId)}`} ` +
        `groupApproval=${settings?.requireApproval === true}`,
    );

    if (role === "other") {
      // 指定了其他加群验证机器人：当前机器人忽略（竞态守卫）
      console.log(
        `Join request ignored: chat ${chat.id} designated verify bot is #${String(settings?.joinVerifyBotId)}, ` +
          `current bot #${botId}`,
      );
      return;
    }
    if (role === "manual") {
      // 未指定加群验证机器人：只落库，人工在「加群申请」页审批
      await recordJoinRequestOnly(ctx.api, user, chat, "telegram");
      return;
    }

    // Bot API 的 ChatJoinRequest.user_chat_id 是首次私聊的合法发送目标，
    // from.id 仍是用户身份 ID。该字段缺失时绝不退回 from.id 猜测私聊地址。
    if (!Number.isSafeInteger(joinRequest.user_chat_id) || joinRequest.user_chat_id === 0) {
      console.error(
        `[join-verify] chat_join_request missing valid user_chat_id: user=${user.id} chat=${chat.id} bot=#${botId}; ` +
          "recording for manual review instead of attempting an unreliable DM",
      );
      await recordJoinRequestOnly(ctx.api, user, chat, "telegram");
      return;
    }

    // 当前机器人是指定的加群验证机器人：解析配置并自动验证/直接通过
    const resolved = await resolveJoinVerify(botId, settings);
    if (!resolved) {
      // 配置不完整（面板关闭/方式不可用）：显式记录并回落手动审核，绝不静默、绝不假验证
      console.error(
        `[join-verify] bot #${botId} is designated for chat ${chat.id} but join-verify config is ` +
          "incomplete (panel off / method missing or disabled) — falling back to manual review",
      );
      await recordJoinRequestOnly(ctx.api, user, chat, "telegram");
      return;
    }

    // 直接通过模式：不创建验证码会话，先记录申请，再调用 Telegram 审批 API。
    if (resolved.method === "direct") {
      const requestDate = new Date(joinRequest.date * 1000);
      if (await wasRecentlyApprovedForUserChat(BigInt(user.id), BigInt(chat.id), 900, requestDate)) {
        console.log(`[join-verify] duplicate already-approved direct request ignored: chat=${chat.id} user=${user.id}`);
        return;
      }
      const token = generateVerificationToken();
      const recorded = await createJoinRequest({
        userId: BigInt(user.id),
        chatId: BigInt(chat.id),
        username: user.username ?? null,
        firstName: user.first_name ?? "",
        lastName: user.last_name ?? null,
        verificationToken: token,
        requestType: "telegram",
        requestTime: requestDate,
      });
      if (!recorded) {
        console.error(`[join-verify] direct approval could not record request: chat=${chat.id} user=${user.id}`);
        return;
      }
      const approval = await autoApproveUser(token, ctx.api, joinRequest.user_chat_id);
      if (!approval.success) {
        console.error(`[join-verify] direct approval failed: chat=${chat.id} user=${user.id} reason=${approval.error}`);
        try { await ctx.api.sendMessage(joinRequest.user_chat_id, `暂时无法自动通过你的加群申请：${approval.error ?? "请联系管理员"}`); } catch { /* best effort */ }
      } else {
        console.log(`[join-verify] direct approval succeeded: chat=${chat.id} user=${user.id}`);
      }
      return;
    }

    // chat_join_request 携带 user_chat_id：机器人可向该会话发消息（无需用户事先 /start）。
    // 透传给 bootstrap，私聊验证提示发送到 user_chat_id 而非 user.id（根因修复：
    // 用户点击"申请加入群组"后未 /start 机器人时，向 user.id 发消息会 403 Forbidden）。
    const userWithChat: JoinVerificationUser = {
      id: user.id,
      username: user.username,
      first_name: user.first_name,
      last_name: user.last_name,
      userChatId: joinRequest.user_chat_id,
    };

    const result = await bootstrapJoinVerification(ctx.api, userWithChat, chat, "telegram", botId, {
      settings,
      resolved,
      requestDate: new Date(joinRequest.date * 1000),
    });
    if (!result) {
      console.error(
        `[join-verify] bootstrap returned null unexpectedly for chat ${chat.id} (bot #${botId}) — recorded for manual review`,
      );
      await recordJoinRequestOnly(ctx.api, user, chat, "telegram");
      return;
    }
    console.log(
      `Join-request verification started: user ${user.id} chat ${chat.id} method=${result.method} ` +
        `promptDelivered=${result.promptDelivered}`,
    );
  });

  return composer;
}
