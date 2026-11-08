import { InlineKeyboard } from "grammy";
import type { BotContext } from "../context";
import {
  getGroupSettings,
  getPendingCodeContext,
  resolveVerificationChannel,
} from "@/database/operations";
import {
  evaluateSubmittedCode,
  type CodeCheckResult,
} from "@/services/verification-flow";
import { kickUnverifiedMember } from "@/services/approval";
import { isGroupReplyInputMode } from "./group-verification";

/** 网络波动、服务端即将重试时立即私聊发送给用户的提示文案 */
const NETWORK_RETRY_NOTICE = "🌐 网络波动，正在重试...";

/** 群内回复输码模式：失败重试类群内回执的自动删除延时（毫秒） */
const GROUP_REPLY_TRANSIENT_DELETE_MS = 8000;
/** 群内回复输码模式：验证失效类群内回执的自动删除延时（毫秒，留更多阅读时间） */
const GROUP_REPLY_EXPIRED_DELETE_MS = 15000;

/**
 * 群内回复输码模式的单条消息删除（best effort）：
 * 需要机器人具备「删除消息」管理员权限；失败仅记录，绝不影响验证主流程。
 */
async function deleteGroupMessageBestEffort(
  api: BotContext["api"],
  chatId: number,
  messageId: number,
  label: string,
): Promise<boolean> {
  try {
    await api.deleteMessage(chatId, messageId);
    return true;
  } catch (error) {
    console.warn(
      `Failed to delete group message (${label}) ${messageId} in chat ${chatId} ` +
        "（需机器人「删除消息」管理员权限）:",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

/**
 * 群内回复输码模式：延时批量删除（回执 + 用户验证码消息），
 * setTimeout 在长驻 Node 进程内可靠触发；Workers/Webhook 场景下为 best effort。
 */
function scheduleGroupReplyCleanup(
  api: BotContext["api"],
  chatId: number,
  messageIds: number[],
  delayMs: number,
): void {
  const targets = messageIds.filter((id) => Number.isFinite(id) && id > 0);
  if (targets.length === 0) return;
  const timer = setTimeout(() => {
    for (const messageId of targets) {
      void deleteGroupMessageBestEffort(api, chatId, messageId, "reply-mode cleanup");
    }
  }, delayMs);
  // Node 长驻进程不阻塞进程退出；Workers 等环境的 number 返回值无 unref，跳过
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
}

/**
 * 群内回复输码模式（v2.1.5）的结果回执与消息清理：
 * - success：立即删除用户验证码消息（群内欢迎/私聊祝贺由验证流程自身发送，
 *   不重复回执，保持群内零残留）；
 * - failed_retry / network_error / 其他状态异常：群内回执（回复用户消息）+ 8 秒后
 *   连同用户验证码消息一并删除；
 * - failed_expired：群内回执 + 15 秒后删除（群内验证提示由 verification-flow
 *   失败分支/超时清理负责删除）。
 *
 * 与私聊路径不同：回复输码用户的操作发生在群内，回执必须在群内可见（用户未必
 * 已启动机器人，私聊不可达）；但回执与验证码消息都必须自动清理，避免验证码、
 * 错误提示长期留在群里。
 */
async function deliverGroupReplyModeResult(
  ctx: BotContext,
  result: CodeCheckResult,
  userMessageId: number | undefined,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const codeMessageId =
    userMessageId && Number.isFinite(userMessageId) && userMessageId > 0 ? userMessageId : undefined;

  // 成功：立即删除验证码消息，群内不重复回执（群内欢迎由 completeGroupVerification 发送）
  if (result.outcome === "success") {
    if (codeMessageId) {
      const deleted = await deleteGroupMessageBestEffort(ctx.api, chatId, codeMessageId, "user code");
      if (deleted) {
        console.log(
          `Group reply-input mode: user code message ${codeMessageId} deleted after success (chat ${chatId})`,
        );
      }
    }
    return;
  }

  // 非成功：群内回执（回复用户验证码消息，定位明确）+ 定时清理
  const text = result.replyText || "验证状态异常，请重新申请加群";
  let feedbackId: number | undefined;
  try {
    const feedback = await ctx.api.sendMessage(chatId, text, {
      ...(codeMessageId
        ? { reply_parameters: { message_id: codeMessageId, allow_sending_without_reply: true } }
        : {}),
    });
    feedbackId = feedback.message_id;
  } catch (error) {
    console.error(`Failed to send group reply-mode feedback to chat ${chatId}:`, error);
  }

  const delayMs = result.outcome === "failed_expired" ? GROUP_REPLY_EXPIRED_DELETE_MS : GROUP_REPLY_TRANSIENT_DELETE_MS;
  scheduleGroupReplyCleanup(ctx.api, chatId, [feedbackId, codeMessageId].filter((id): id is number => id !== undefined), delayMs);
  console.log(
    `Group reply-input mode feedback sent: chat ${chatId} outcome=${result.outcome} cleanup in ${delayMs}ms`,
  );
}
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
  // v1.1.5：通知层失败（用户拉黑 bot / Telegram 瞬时错误）必须兜住并记录详细错误，
  // 不允许中断调用方后续流程（失效路径的通知也是用户唯一重新入群的入口）
  try {
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
  } catch (error) {
    console.error(
      `Failed to send re-apply join button to user ${userId} for chat ${chatId}:`,
      error,
    );
  }
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
 * v2.1.5 受控例外：群内回复输码模式（reply_code_in_group=true）下回执改在群内
 * 发送（回复用户验证码消息）并自动删除 —— 用户在群内完成输码，未必私聊可达。
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

  // v2.0.5 群内验证模式前提条件：群聊内禁止明文输码（回复消息全员可见）。
  // 群内验证的输入只发生在验证网页（URL 按钮）或 4 选 1 callback 里；
  // 用户私聊（DM）输码不受限 —— 私聊内容群友本就不可见，作为兼容通道保留。
  //
  // v2.1.5 受控例外（群内回复输码模式）：reply_code_in_group=true 且群内渠道时，
  // force_reply 提示引导用户回复输码（验证码短暂可见，管理员已明确接受），
  // 回执与验证码消息在验证结束后自动删除；captcha 会话仍只走验证网页。
  let groupReplyMode = false;
  if (ctx.chat && ctx.chat.type !== "private") {
    const chatSettings = await getGroupSettings(BigInt(ctx.chat.id));
    const groupChannel =
      resolveVerificationChannel(chatSettings, ctx.chat.id) === "group";
    groupReplyMode = groupChannel && chatSettings?.replyCodeInGroup === true;
    if (groupChannel && !groupReplyMode) {
      console.log(
        `Blocked plain-text code input in group ${ctx.chat.id} (verification_channel=group): ` +
          `user ${from.id} must use the in-group button/web page`,
      );
      return null;
    }
  }

  // v2.1.1：ctx.api（事件接收 bot）透传 —— 验证通过后的审批（approveChatJoinRequest）
  // 由收到本次输码的机器人执行，不再依赖群组绑定行与主 bot token。
  // 旧实现断点：绑定缺失时回落主 bot，edge 未配置主 token 时 autoApproveUser 抛错 →
  // 「输入验证码后不真实进群」（用户收到成功文案但 Telegram 侧申请从未被批准）。
  const result = await evaluateSubmittedCode({
    userId: BigInt(from.id),
    username: from.username ?? null,
    code: codeText,
    preloaded: preloaded ?? undefined,
    eventApi: ctx.api,
    onNetworkRetry: async () => {
      await ctx.api.sendMessage(from.id, NETWORK_RETRY_NOTICE);
    },
  });

  // no_pending：非验证会话中的普通消息，交还后续中间件处理。
  // stateless-question 路径（回复验证提示）据此走「失效反馈」分支，见 verification-question.ts
  if (result.outcome === "no_pending" && !result.replyText) {
    return result;
  }

  // v2.1.5 群内回复输码模式：用户在群内完成输码，回执与消息清理全部在群内进行
  //（用户未必已启动机器人，私聊不可达）；不走下方私聊回执/私聊「申请加群」按钮路径
  if (groupReplyMode) {
    await deliverGroupReplyModeResult(ctx, result, ctx.message?.message_id);
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

  // 验证结果文案一律私聊发送（不用 ctx.reply，避免消息落到输码所在的群聊）。
  // v1.1.5：私聊发送失败（用户拉黑 bot / Telegram 侧瞬时错误）必须兜住并记录详细错误——
  // 通知层失败不允许中断后续「申请加群」按钮发送，也不允许让 webhook 处理以异常收场，
  // 否则用户看到的现象就是「输入验证码后无任何反应」（v1.1.4 同类反馈根因之一）。
  try {
    await ctx.api.sendMessage(from.id, result.replyText);
  } catch (error) {
    console.error(
      `Failed to DM verification result to user ${from.id} (outcome=${result.outcome}):`,
      error,
    );
  }

  // 验证失效：紧随失效文案发送「申请加群」按钮（入群申请链接），
  // 把用户输入框的 force_reply 状态替换为可重新发起加群申请的按钮
  if (result.outcome === "failed_expired" && result.reapplyChatId) {
    if (result.joinRequestType === "direct") {
      // v2.0.7 直连入群踢出开关（默认关闭）：直连用户（公开邀请链接/被拉入群的
      // 已有用户）验证失败不自动踢出，保留在群内（evaluateSubmittedCode 已按
      // kick_direct_joins 落库值决策 —— stayedInGroup=true 时这里不再执行踢出，
      // 也不再附「申请加群」按钮：用户仍在群内，无需重新申请）。
      if (result.stayedInGroup) {
        try {
          await ctx.api.sendMessage(
            from.id,
            "本次验证已失效，你仍保留在群组中，无需重新申请。",
          );
          console.log(
            `Direct-join user ${from.id} (chat ${result.reapplyChatId}) failed verification — ` +
              "kick_direct_joins disabled, stays in group",
          );
        } catch (error) {
          console.error(
            `Failed to send stayed-in-group notice to user ${from.id}:`,
            error,
          );
        }
      } else {
        // 开关开启（旧行为）：踢出（ban+unban，可重新申请）——
        // 否则普通邀请链接就能绕过验证 —— 私聊告知结果并回复「申请加群」按钮（群内零消息）
        let kicked = false;
        try {
          kicked = await kickUnverifiedMember(
            BigInt(result.reapplyChatId),
            BigInt(from.id),
            ctx.api,
          );
        } catch (error) {
          console.error(`Failed to kick unverified direct-join user ${from.id}:`, error);
        }
        // v1.1.5：通知层发送失败兜住并记录，不影响已完成的踢出动作与日志
        try {
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
        } catch (error) {
          console.error(
            `Failed to send direct-join re-apply notice to user ${from.id} for chat ${result.reapplyChatId} (kicked=${kicked}):`,
            error,
          );
        }
      }
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
 *
 * v2.0.6 D1 读行额度优化（关键）：本 handler 注册在 message:text 上 —— 机器人
 * 收到的每一条文本消息都会走到这里。原先每条消息都先打一次
 * getPendingCodeContext（verification_sessions 索引查询），但群内验证模式
 * （默认渠道）下群聊文本输码被明令禁止（输码只发生在网页/4选1按钮），
 * 这次查询纯属浪费 —— 群活跃时每条消息白打一次 D1。
 * 现改为：群聊消息先查群设置（300s KV 缓存 + 进程内 memo，命中时不打 D1），
 * 群内验证模式直接跳过会话查询；仅私聊模式（dm）群组/私聊消息才查会话。
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

  // 群内验证模式短路（v2.0.6，v2.0.12 三态）：群聊 + 群内渠道（含 auto 判定超级群）→
  // 文本输码永不生效，不必查询该用户是否挂着待验证会话（省掉每条群消息 1 次 D1 会话查询）
  // v2.1.5：群内回复输码模式（reply_code_in_group=true）开启时不短路 ——
  // force_reply 提示引导的群内回复输码需要进入会话校验
  if (ctx.chat && ctx.chat.type !== "private") {
    const chatSettings = await getGroupSettings(BigInt(ctx.chat.id));
    if (
      resolveVerificationChannel(chatSettings, ctx.chat.id) === "group" &&
      chatSettings?.replyCodeInGroup !== true
    ) {
      await next();
      return;
    }
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
