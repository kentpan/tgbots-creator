import type { BotContext } from "../context";
import { config } from "@/config/settings";
import { getRuntimeSettings, type RuntimeSettings } from "@/config/runtime-settings";
import {
  createJoinRequest,
  createVerificationSession,
  getGroupSettings,
  getPendingSessionForUserChat,
  wasRecentlyApprovedForUserChat,
} from "@/database/operations";
import { generateVerificationToken, generateJoinCode } from "@/utils/crypto";
import { htmlEscape } from "@/utils/html";
import { utcnow } from "@/utils/time";
import { InlineKeyboard, type Api } from "grammy";
import { CODE_SELF_DEFAULT_PROMPT, sendCodeSelfPrompt } from "../verification-prompt";
import { muteAndSendGroupPrompt } from "./group-verification";
import { approveTelegramJoinRequest } from "@/services/approval";
import { registerTelegramChat } from "@/services/chat-registry";
import {
  loadGroupSettingsForChat,
  resolveJoinVerify,
  type ResolvedJoinVerify,
} from "@/services/join-verify";
import { chatCapabilities, chatKindFromChatType } from "@/services/chat-type";

/**
 * 加群验证引导（真实 Telegram 路径）：
 *
 * 验证方式配置已从群级迁到机器人级（bots.config.joinVerify），本模块只负责
 * bootstrap：解析（services/join-verify.ts）→ 落库 → 发送验证提示。
 *
 * 三条入口：
 * 1. chat_join_request（被指定的加群验证机器人）→ 一律私聊验证：
 *    先验证后批准（通过 approveChatJoinRequest 静默放行，失败 3 次 decline）；
 * 2. chat_member（直连入群补验证）：超级群 → 群内验证，基础群 → 私聊验证；
 * 3. 频道：物理不支持群内验证（订阅者不能发言），强制私聊验证。
 *
 * 未被指定为加群验证机器人（或机器人加群验证面板关闭/方式不可用）时：
 * 只落库加群申请记录（pending），由管理员在「加群申请」页手动审批 —— 不自动验证。
 */

export interface JoinVerificationUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  /**
   * chat_join_request 专属：user_chat_id（加群申请私聊会话 ID）。
   * 来自 ChatJoinRequest.user_chat_id —— 机器人可向该会话发消息，
   * 无需用户事先 /start 机器人（与 user.id 不同，user.id 私聊需先 /start）。
   * requestType="telegram" 时必填；"direct" 时为 undefined（回落 user.id）。
   */
  userChatId?: number;
}

export interface JoinVerificationChat {
  id: number;
  title?: string;
  type: string;
}

interface BootstrapResult {
  /** 会话与加群申请记录是否创建成功 */
  created: boolean;
  /** 验证提示是否已成功送达（群内模式 = 群内消息；私聊模式 = 用户私聊） */
  promptDelivered: boolean;
  method: string;
}

/**
 * 只落库加群申请（手动审核路径）：创建 pending 加群申请记录，
 * 供「加群申请」管理页展示与人工批准/拒绝；不发验证提示、不建验证会话。
 */
export async function recordJoinRequestOnly(
  api: Api,
  user: JoinVerificationUser,
  chat: JoinVerificationChat,
  requestType: "telegram" | "direct",
): Promise<boolean> {
  // 真实群组登记（幂等）：让群组出现在管理后台群组列表
  if (chat.type === "supergroup" || chat.type === "group" || chat.type === "channel") {
    try {
      await registerTelegramChat({
        chatId: BigInt(chat.id),
        chatTitle: chat.title ?? null,
        chatType: chat.type,
        botToken: api.token,
      });
    } catch (registryError) {
      console.warn("Failed to register real chat from join flow:", registryError);
    }
  }
  try {
    const recorded = await createJoinRequest({
      userId: BigInt(user.id),
      chatId: BigInt(chat.id),
      username: user.username ?? null,
      firstName: user.first_name ?? "",
      lastName: user.last_name ?? null,
      verificationToken: generateVerificationToken(),
      requestType,
    });
    console.log(
      `Join request recorded for manual review: user ${user.id} chat ${chat.id} ` +
        `type=${requestType} ${recorded ? "ok" : "FAILED"}`,
    );
    return Boolean(recorded);
  } catch (error) {
    console.error(`Failed to record join request for chat ${chat.id}:`, error);
    return false;
  }
}

/**
 * 群内验证 bootstrap（直连入群 + 超级群 auto 渠道）：用户已物理在群内，
 * 创建会话 → 禁言 → 群内验证消息；通过解禁 / 失败超时踢出。
 * 验证方式/超时/尝试次数全部来自 resolved（机器人级配置解析结果）。
 */
async function bootstrapGroupVerification(
  api: Api,
  user: JoinVerificationUser,
  chat: JoinVerificationChat,
  requestType: "direct",
  runtime: RuntimeSettings,
  settings: NonNullable<Awaited<ReturnType<typeof getGroupSettings>>>,
  resolved: ResolvedJoinVerify,
): Promise<BootstrapResult> {
  // 幂等守卫：同一用户同群已有未完成会话（抖动/重复投递）不重复创建会话、不重复发群内消息
  const existing = await getPendingSessionForUserChat(BigInt(user.id), BigInt(chat.id));
  if (existing) {
    console.log(
      `Pending group verification already exists: user ${user.id} chat ${chat.id} ` +
        `session=${existing.token.slice(0, 8)}... — skip duplicate bootstrap`,
    );
    return {
      created: true,
      promptDelivered: true,
      method: existing.method,
    };
  }

  const verificationToken = generateVerificationToken();

  const dbJoinRequest = await createJoinRequest({
    userId: BigInt(user.id),
    chatId: BigInt(chat.id),
    username: user.username ?? null,
    firstName: user.first_name ?? "",
    lastName: user.last_name ?? null,
    verificationToken,
    requestType,
  });
  if (!dbJoinRequest) {
    console.error(`Failed to create join request for user ${user.id} (${requestType})`);
    return { created: false, promptDelivered: false, method: "none" };
  }

  const useSelfCode = resolved.method === "code_self";
  const joinCode = useSelfCode ? generateJoinCode() : null;

  const session = await createVerificationSession({
    token: verificationToken,
    userId: BigInt(user.id),
    chatId: BigInt(chat.id),
    expiresAt: new Date(utcnow().getTime() + resolved.timeoutSeconds * 1000),
    method: resolved.method,
    expectedCode: joinCode,
    methodId: resolved.methodDbId,
    maxAttempts: resolved.maxAttempts,
  });
  if (!session) {
    console.error(`Failed to create verification session for user ${user.id} (${requestType})`);
    return { created: false, promptDelivered: false, method: "none" };
  }

  // 禁言 + 群内验证消息（输入内容其他成员不可见：网页按钮 / 4 选 1 callback）
  const outcome = await muteAndSendGroupPrompt(
    api,
    { id: chat.id, title: chat.title },
    user,
    session,
    settings,
    runtime.baseUrl,
    runtime.verificationButtonText,
  );

  return { created: true, promptDelivered: outcome.sent, method: resolved.method };
}

/**
 * 私聊验证 bootstrap（申请制入群 + 基础群直连 + 频道）：
 * 创建加群申请 + 验证会话（锁定方式库 id 与最大尝试次数）→ 私聊发送验证提示。
 * 申请制（requestType=telegram）：验证通过 → approveChatJoinRequest 静默放行；
 * 失败 3 次 → declineChatJoinRequest（评估管道 verification-flow 已实现）。
 * stars 方式：发送星星发票（payload=join_verify:<token>），支付成功事件放行。
 */
async function bootstrapDmVerification(
  api: Api,
  user: JoinVerificationUser,
  chat: JoinVerificationChat,
  requestType: "telegram" | "direct",
  runtime: RuntimeSettings,
  settings: Awaited<ReturnType<typeof getGroupSettings>>,
  resolved: ResolvedJoinVerify,
): Promise<BootstrapResult> {
  // 幂等守卫（v2.1.5）：同用户同群未完成会话 / 近 15 分钟已批准 → 不重复创建与发送
  const existingPending = await getPendingSessionForUserChat(BigInt(user.id), BigInt(chat.id));
  if (existingPending) {
    // Telegram 可能重投 chat_join_request；若首轮建会话成功但提示消息发送失败，
    // 旧逻辑会把“已有会话”误报为 promptDelivered=true 并永久跳过提示重发。
    // 使用同一 session/token/code 重发，不新建 D1 行、不重置尝试次数或过期时间。
    const targetChatId = user.userChatId ?? user.id;
    let promptDelivered = false;
    try {
      if (existingPending.method === "code_self" && existingPending.expectedCode) {
        const delivery = await sendCodeSelfPrompt(api, targetChatId, {
          promptText: settings?.promptText || CODE_SELF_DEFAULT_PROMPT,
          code: existingPending.expectedCode,
          expiresAt: existingPending.expiresAt,
          contextLabel: `${requestType} retry`,
        });
        promptDelivered = delivery.delivered;
      } else if (existingPending.method === "code_api") {
        const promptText = settings?.promptText ?? "🔐 请在下方输入框直接发送验证码完成验证";
        await api.sendMessage(
          targetChatId,
          `${htmlEscape(promptText)}\n\n请直接在下方输入框发送验证码，无需回复本消息。`,
          { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
        );
        promptDelivered = true;
      } else if (existingPending.method === "captcha") {
        const keyboard = new InlineKeyboard().webApp(
          runtime.verificationButtonText,
          `${runtime.baseUrl}/verify?token=${existingPending.token}`,
        );
        await api.sendMessage(
          targetChatId,
          `欢迎加入群组${htmlEscape(chat.title ?? "群组")}！请点击下方链接完成人机验证`,
          { parse_mode: "HTML", reply_markup: keyboard },
        );
        promptDelivered = true;
      }
    } catch (error) {
      console.warn(
        `[join-verify] duplicate request prompt resend failed: user=${user.id} chat=${chat.id} ` +
          `target=${targetChatId} method=${existingPending.method}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    console.log(
      `Pending DM verification already exists: user ${user.id} chat ${chat.id} ` +
        `session=${existingPending.token.slice(0, 8)}... — promptResent=${promptDelivered}`,
    );
    return {
      created: true,
      promptDelivered,
      method: existingPending.method,
    };
  }
  const recentlyApproved = await wasRecentlyApprovedForUserChat(BigInt(user.id), BigInt(chat.id));
  if (recentlyApproved) {
    console.log(
      `Join request recently approved: user ${user.id} chat ${chat.id} — skip duplicate DM bootstrap`,
    );
    return { created: false, promptDelivered: true, method: "none" };
  }

  const verificationToken = generateVerificationToken();

  const dbJoinRequest = await createJoinRequest({
    userId: BigInt(user.id),
    chatId: BigInt(chat.id),
    username: user.username ?? null,
    firstName: user.first_name ?? "",
    lastName: user.last_name ?? null,
    verificationToken,
    requestType,
  });

  if (!dbJoinRequest) {
    console.error(`Failed to create join request for user ${user.id} (${requestType})`);
    return { created: false, promptDelivered: false, method: "none" };
  }

  const useSelfCode = resolved.method === "code_self";
  const joinCode = useSelfCode ? generateJoinCode() : null;

  const expiresAt = new Date(utcnow().getTime() + resolved.timeoutSeconds * 1000);
  const verificationSession = await createVerificationSession({
    token: verificationToken,
    userId: BigInt(user.id),
    chatId: BigInt(chat.id),
    expiresAt,
    method: resolved.method,
    expectedCode: joinCode,
    methodId: resolved.methodDbId,
    maxAttempts: resolved.maxAttempts,
  });

  if (!verificationSession) {
    console.error(`Failed to create verification session for user ${user.id} (${requestType})`);
    return { created: false, promptDelivered: false, method: "none" };
  }

  if (resolved.method === "code_api") {
    const promptText = settings?.promptText ?? "🔐 请在下方输入框直接发送验证码完成验证";
    const targetChatId = user.userChatId ?? user.id;
    try {
      // chat_join_request 的 user_chat_id 只作为发送目标；身份与会话仍使用 from.id。
      // 申请用户处于私聊会话，私聊消息不受群隐私模式限制，无需 force_reply。
      // 用户直接发送文本，由 handleCodeInput 按 from.id 查找待验证会话。
      await api.sendMessage(
        targetChatId,
        `${htmlEscape(promptText)}\n\n请直接在下方输入框发送验证码，无需回复本消息。`,
        {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        },
      );
      console.log(`Code verification prompt sent to chat ${targetChatId} (user ${user.id}, ${requestType})`);
      return { created: true, promptDelivered: true, method: "code_api" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("chat not found") || message.toLowerCase().includes("forbidden")) {
        console.warn(
          `Cannot send code prompt to chat ${targetChatId} (user ${user.id}, ${requestType}): chat not reachable; ` +
            "prompt will be resent when the user /starts the bot; session expires per timeout",
        );
        return { created: true, promptDelivered: false, method: "code_api" };
      }
      console.error("Failed to send code verification prompt:", error);
      return { created: true, promptDelivered: false, method: "code_api" };
    }
  }

  // code_self：私聊发送自生成的入群验证码（直接输入，不要求回复提示消息）
  if (useSelfCode && joinCode) {
    const promptText = settings?.promptText || CODE_SELF_DEFAULT_PROMPT;
    const targetChatId = user.userChatId ?? user.id;
    const delivery = await sendCodeSelfPrompt(api, targetChatId, {
      promptText,
      code: joinCode,
      expiresAt,
      contextLabel: requestType,
    });
    return { created: true, promptDelivered: delivery.delivered, method: "code_self" };
  }

  // captcha（WebApp 人机验证）：私聊发送验证网页按钮
  const webAppUrl = `${runtime.baseUrl}/verify?token=${verificationToken}`;
  const keyboard = new InlineKeyboard().webApp(runtime.verificationButtonText, webAppUrl);

  try {
    const chatTitle = htmlEscape(chat.title ?? "群组");
    const welcomeText = `欢迎加入群组${chatTitle}！请点击下方链接完成人机验证`;
    const targetChatId = user.userChatId ?? user.id;
    await api.sendMessage(targetChatId, welcomeText, { reply_markup: keyboard });
    console.log(`Verification message sent to chat ${targetChatId} (user ${user.id}, ${requestType})`);
    return { created: true, promptDelivered: true, method: "captcha" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("chat not found") || message.toLowerCase().includes("forbidden")) {
      const targetChatId = user.userChatId ?? user.id;
      console.warn(
        `Cannot send verification message to chat ${targetChatId} (user ${user.id}, ${requestType}): chat not reachable; ` +
          "prompt will be resent when the user /starts the bot; session expires per timeout",
      );
      return { created: true, promptDelivered: false, method: "captcha" };
    }
    console.error("Failed to send verification message:", error);
    return { created: true, promptDelivered: false, method: "captcha" };
  }
}

/**
 * 加群验证统一 bootstrap（唯一入口）：
 * 解析机器人级加群验证配置 → 按渠道分派（申请制/频道=私聊；直连超级群=群内）。
 * 返回 null = 配置不完整（调用方按手动审核处理）。
 */
export async function bootstrapJoinVerification(
  api: Api,
  user: JoinVerificationUser,
  chat: JoinVerificationChat,
  requestType: "telegram" | "direct",
  botId: bigint,
  preloaded?: {
    settings: Awaited<ReturnType<typeof loadGroupSettingsForChat>>;
    resolved: ResolvedJoinVerify;
  },
): Promise<BootstrapResult | null> {
  const runtime = await getRuntimeSettings(config);
  // chat_join_request Composer 已加载并解析过配置时直接复用，避免重复 D1 读取。
  const settings = preloaded ? preloaded.settings : await loadGroupSettingsForChat(BigInt(chat.id));
  const resolved = preloaded?.resolved ?? (await resolveJoinVerify(botId, settings));
  if (!resolved) {
    return null;
  }

  // 渠道判定（源头规则）：频道不支持群内验证 → 私聊；申请制 → 私聊（先验证后批准）；
  // 直连 → 超级群群内验证 / 基础群私聊（auto 语义）
  const kind = chatKindFromChatType(chat.type);
  const capabilities = chatCapabilities(kind);
  const dmChannel =
    requestType === "telegram" ||
    !capabilities.inGroupVerification ||
    settings === null;

  if (dmChannel) {
    return bootstrapDmVerification(api, user, chat, requestType, runtime, settings, resolved);
  }
  if (!settings) {
    return null;
  }
  return bootstrapGroupVerification(api, user, chat, requestType, runtime, settings, resolved);
}

/**
 * 直连入群防线：普通邀请链接/被拉入群直接进来的成员 → 补验证，超时/失败踢出。
 * 验证方式取「收到本事件的机器人」的加群验证配置（botId 必传）。
 */
export async function handleChatMemberUpdate(ctx: BotContext, botId: bigint): Promise<void> {
  const memberUpdate = ctx.chatMember;
  if (!memberUpdate) {
    return;
  }
  const chat = memberUpdate.chat;
  const newMember = memberUpdate.new_chat_member;
  const oldMember = memberUpdate.old_chat_member;
  const user = newMember.user;

  // 离开/被踢/被封：撤销其未完成的验证任务，避免悬挂会话
  if (newMember.status === "left" || newMember.status === "kicked") {
    const wasPresent =
      oldMember.status === "member" ||
      oldMember.status === "restricted" ||
      oldMember.status === "administrator";
    if (!wasPresent || user.is_bot) {
      return;
    }
    const { expirePendingSessionsForUserChat } = await import("@/database/operations");
    const cleaned = await expirePendingSessionsForUserChat(BigInt(user.id), BigInt(chat.id));
    if (cleaned) {
      console.log(
        `Unverified member left/kicked: user ${user.id} chat ${chat.id} — pending verification session expired`,
      );
    }
    return;
  }

  // 只处理「新加入为普通成员」的首次事件（旧状态为 left/kicked）；
  // restricted 权限微调、管理员身份变更（old 也是 administrator）等不触发验证。
  const joinedFresh = oldMember.status === "left" || oldMember.status === "kicked";
  const joinedAsMember =
    newMember.status === "member" || newMember.status === "restricted";
  if (!joinedFresh || !joinedAsMember) {
    return;
  }

  if (user.is_bot) {
    return;
  }
  // 经本机器人审批入群（join-request 流程成功）：验证已完成，不重复验证
  if (memberUpdate.via_join_request) {
    return;
  }

  // 真实直连入群一律登记真实群组（幂等）
  if (chat.type === "supergroup" || chat.type === "group" || chat.type === "channel") {
    try {
      await registerTelegramChat({
        chatId: BigInt(chat.id),
        chatTitle: chat.title ?? null,
        chatType: chat.type,
        botToken: ctx.api.token,
      });
    } catch (registryError) {
      console.warn("Failed to register real chat from direct join:", registryError);
    }
  }

  // 直连入群验证方式 = 收到事件的机器人的加群验证配置；
  // 未配置/面板关闭 → 只落库记录（手动审核），不拦截不验证
  const result = await bootstrapJoinVerification(ctx.api, user, chat, "direct", botId);
  if (!result) {
    console.log(
      `Direct join into chat ${chat.id} without join-verify config (bot #${botId}): ` +
        "recorded for manual review — no prompt sent, no kick",
    );
    await recordJoinRequestOnly(ctx.api, user, chat, "direct");
    return;
  }
  console.log(
    `Direct join without bot approval detected: user ${user.id} (${user.username}) ` +
      `entered chat ${chat.id} via ${memberUpdate.invite_link ? "invite link" : "manual add"} — ` +
      `starting ${result.method} verification`,
  );
}
