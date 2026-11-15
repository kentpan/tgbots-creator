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
import { BOT_TEXT_DEFAULTS, renderBotTextVars, type BotTextVars } from "@/services/bot-messages";
import { muteAndSendGroupPrompt } from "./group-verification";
import { approveTelegramJoinRequest } from "@/services/approval";
import { registerTelegramChat } from "@/services/chat-registry";
import {
  loadGroupSettingsForChat,
  resolveJoinVerify,
  resolveDesignatedBot,
  type ResolvedJoinVerify,
} from "@/services/join-verify";
import { chatCapabilities, chatKindFromChatType } from "@/services/chat-type";

/**
 * 加群验证引导（真实 Telegram 路径）：
 *
 * 机器人级只负责能力开关与全局参数，群组策略/验证方式保存在 group_settings，本模块只负责
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
 * 验证方式来自群组绑定，超时/尝试次数使用机器人级默认覆盖。
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
/** v3.0.3：读取 bots.config.texts.dm_join_prompt（申请入群私聊提示）+ 变量取值；
 * 缺失回落默认，置空 = 不发送。变量来自 bots 表（name/username）。 */
async function resolveDmJoinPrompt(botId?: bigint | null): Promise<{ text: string; vars: BotTextVars }> {
  let text = BOT_TEXT_DEFAULTS.dm_join_prompt;
  let vars: BotTextVars = {};
  try {
    if (botId) {
      const { getBot } = await import("@/database/operations");
      const botRow = await getBot(botId);
      if (botRow) {
        vars = { botName: botRow.name, botUsername: botRow.username ?? null };
        const parsed = JSON.parse(botRow.config || "{}") as { texts?: Record<string, unknown> };
        const value = parsed.texts?.dm_join_prompt;
        if (typeof value === "string") text = value;
      }
    }
  } catch {
    /* 配置读取失败回落默认文案 */
  }
  return { text: renderBotTextVars(text, vars), vars };
}

async function bootstrapDmVerification(
  api: Api,
  user: JoinVerificationUser,
  chat: JoinVerificationChat,
  requestType: "telegram" | "direct",
  runtime: RuntimeSettings,
  settings: Awaited<ReturnType<typeof getGroupSettings>>,
  resolved: ResolvedJoinVerify,
  requestDate?: Date,
  botId?: bigint | null,
): Promise<BootstrapResult> {
  // 同一 Telegram update 重投（date 相同）保持幂等；真实再次申请（date 更新）
  // 必须创建新 token 和 attempts=0 的新会话，不能继承上次输错次数。
  const existingPending = await getPendingSessionForUserChat(
    BigInt(user.id),
    BigInt(chat.id),
    requestDate,
  );
  if (existingPending) {
    // Telegram 可能重投 chat_join_request；若首轮建会话成功但提示消息发送失败，
    // 旧逻辑会把“已有会话”误报为 promptDelivered=true 并永久跳过提示重发。
    // 使用同一 session/token/code 重发，不新建 D1 行、不重置尝试次数或过期时间。
    const targetChatId = user.userChatId ?? user.id;
    let promptDelivered = false;
    try {
      if (existingPending.method === "code_self" && existingPending.expectedCode) {
        // v3.0.3：提示文案 NULL = 未配置回落默认；空串 = 用户选择不发送
        const promptText = settings?.promptText ?? CODE_SELF_DEFAULT_PROMPT;
        if (promptText.trim()) {
          const delivery = await sendCodeSelfPrompt(api, targetChatId, {
            promptText,
            code: existingPending.expectedCode,
            expiresAt: existingPending.expiresAt,
            contextLabel: `${requestType} retry`,
          });
          promptDelivered = delivery.delivered;
        }
      } else if (existingPending.method === "code_api") {
        // v3.0.3：重投的 chat_join_request 同样发送入群私聊提示（文案可配置、置空不发）
        const joinPrompt = (await resolveDmJoinPrompt(botId)).text.trim();
        if (joinPrompt) {
          try {
            await api.sendMessage(targetChatId, joinPrompt, {
              link_preview_options: { is_disabled: true },
            });
            promptDelivered = true;
          } catch {
            /* 私聊不可达时静默（用户 /start 后会重发提示） */
          }
        }
        console.log(
          `Pending code_api DM verification exists: user ${user.id} chat ${chat.id} ` +
            `session=${existingPending.token.slice(0, 8)}... — promptResent=${promptDelivered}`,
        );
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
  const recentlyApproved = await wasRecentlyApprovedForUserChat(
    BigInt(user.id),
    BigInt(chat.id),
    900,
    requestDate,
  );
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
    requestTime: requestDate,
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
  console.log(
    `[join-verify] fresh DM verification session initialized: user=${user.id} chat=${chat.id} ` +
      `token=${verificationToken.slice(0, 8)}... attempts=${verificationSession.attempts} ` +
      `method=${verificationSession.method}`,
  );

  if (resolved.method === "code_api") {
    // v3.0.3：申请到达后机器人在用户私聊发送入群提示（用户点击「申请加入群组」后
    // 就地直接输码 —— 真实 APP 等价于仿真屏的「自动跳转机器人私聊」视图切换）。
    // 文案 = bots.config.texts.dm_join_prompt（文案配置中心可自定义），置空 = 不发送。
    const targetChatId = user.userChatId ?? user.id;
    const joinPrompt = (await resolveDmJoinPrompt(botId)).text.trim();
    if (!joinPrompt) {
      console.log(
        `code_api verification session ready: user ${user.id} chat ${chat.id} ` +
          `token=${verificationToken.slice(0, 8)}... — dm_join_prompt is empty, no DM sent`,
      );
      return { created: true, promptDelivered: false, method: "code_api" };
    }
    try {
      await api.sendMessage(targetChatId, joinPrompt, {
        link_preview_options: { is_disabled: true },
      });
      console.log(`Join-request DM prompt sent to chat ${targetChatId} (user ${user.id}, ${requestType})`);
      return { created: true, promptDelivered: true, method: "code_api" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("chat not found") || message.toLowerCase().includes("forbidden")) {
        console.warn(
          `Cannot send join-request prompt to chat ${targetChatId} (user ${user.id}, ${requestType}): chat not reachable; ` +
            "prompt will be resent when the user /starts the bot; session expires per timeout",
        );
        return { created: true, promptDelivered: false, method: "code_api" };
      }
      console.error("Failed to send join-request DM prompt:", error);
      return { created: true, promptDelivered: false, method: "code_api" };
    }
  }

  // code_self：私聊发送自生成的入群验证码（直接输入，不要求回复提示消息）
  // v3.0.3：提示文案 NULL = 未配置回落默认；空串 = 用户选择不发送
  if (useSelfCode && joinCode) {
    const promptText = settings?.promptText ?? CODE_SELF_DEFAULT_PROMPT;
    if (!promptText.trim()) {
      console.log(
        `code_self prompt skipped (prompt_text empty = do-not-send): user ${user.id} chat ${chat.id}`,
      );
      return { created: true, promptDelivered: false, method: "code_self" };
    }
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
    requestDate?: Date;
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
    return bootstrapDmVerification(
      api, user, chat, requestType, runtime, settings, resolved, preloaded?.requestDate, botId,
    );
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

  // v2.3.5 群组「新成员审核」总开关关闭时，群组自动审核机器人配置保留但不生效；
  // 开启时，普通邀请链接直连入群也按该群绑定的 verify/direct 策略执行。
  const groupSettings = await loadGroupSettingsForChat(BigInt(chat.id));
  if (groupSettings?.requireApproval !== true) {
    console.log(`[join-verify] approval disabled for chat=${chat.id}; direct-join verification skipped`);
    return;
  }
  const directRole = resolveDesignatedBot(groupSettings, botId);
  if (directRole !== "designated") {
    console.log(`[join-verify] direct-join event ignored for bot=#${botId} chat=${chat.id}; role=${directRole}`);
    return;
  }
  const directResolved = await resolveJoinVerify(botId, groupSettings);
  if (directResolved?.method === "direct") {
    console.log(`[join-verify] direct mode: user=${user.id} joined chat=${chat.id}; no verification required`);
    return;
  }
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
