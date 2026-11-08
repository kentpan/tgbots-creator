import type { BotContext } from "../context";
import { config } from "@/config/settings";
import { getRuntimeSettings, type RuntimeSettings } from "@/config/runtime-settings";
import {
  createJoinRequest,
  createVerificationSession,
  getGroupSettings,
  getPendingSessionForUserChat,
  getVerificationMethod,
  resolveVerificationChannel,
  wasRecentlyApprovedForUserChat,
} from "@/database/operations";
import { generateVerificationToken, generateJoinCode } from "@/utils/crypto";
import { htmlEscape } from "@/utils/html";
import { utcnow } from "@/utils/time";
import { InlineKeyboard, type Api } from "grammy";
import { codeQuestion } from "../verification-question";
import { CODE_SELF_DEFAULT_PROMPT, sendCodeSelfPrompt } from "../verification-prompt";
import { muteAndSendGroupPrompt } from "./group-verification";
import { approveTelegramJoinRequest } from "@/services/approval";
import { registerTelegramChat } from "@/services/chat-registry";

/**
 * 加群验证引导（真实 Telegram 路径）：
 *
 * 两条入口共用同一核心 bootstrapJoinVerification：
 * 1. chat_join_request —— 用户通过「入群申请链接」申请加群（需要机器人审批，入群前验证）
 * 2. chat_member       —— 用户通过普通邀请链接/被拉入群直接进来了（入群后补验证，超时/失败踢出）
 *
 * 验证渠道（v2.0.12 三态，group_settings.verification_channel）：
 * - "auto"（默认）按群组类型自动：超级群/频道 → 群内验证；基础群 → 私聊验证；
 * - "group" 群内验证：入群申请先批准 → 用户进群 → 禁言 → 群内验证消息
 *   （captcha/code_api = 网页按钮，code_self = 4 选 1 按钮），输入内容其他成员
 *   不可见；验证通过解禁 + 群内欢迎，失败/超时踢出。
 * - "dm" 私聊验证（v1.1.3 旧行为）：所有验证提示/结果只通过机器人私聊发送，
 *   群组内绝不发送任何验证消息；私聊发送失败（用户尚未启动机器人）时仅记录日志：
 *   - 申请类用户：之后点「开始」时 /start 会重发验证提示（pending 会话仍在）；
 *   - 直连入群用户：验证超时后由清理任务自动踢出，可重新申请。
 */

export interface JoinVerificationUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
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
  method: "code_api" | "code_self" | "captcha" | "none";
}

/**
 * 群内验证模式 bootstrap（v2.0.5，v2.1.1 顺序修正）：
 * 1. join_request：先批准 Telegram 侧入群申请让用户进群（join_requests.status 保持
 *    pending —— 超时清理/统计依赖该语义），批准失败回落私聊验证旧行为；
 *    审批必须在幂等守卫之前（守卫短路会让重复申请永远无人批准，v2.1.1 修复）；
 * 2. 幂等守卫：同一用户同群已有未完成会话（申请批准后的 chat_member 抖动/重复投递）
 *    不重复创建会话、不重复发群内消息；
 * 3. 创建验证会话 → 禁言 → 群内验证消息（按钮按验证方式组装）。
 */
async function bootstrapGroupVerification(
  api: Api,
  user: JoinVerificationUser,
  chat: JoinVerificationChat,
  requestType: "telegram" | "direct",
  runtime: RuntimeSettings,
  groupSettings: NonNullable<Awaited<ReturnType<typeof getGroupSettings>>>,
): Promise<BootstrapResult> {
  // v2.1.1 顺序修复：Telegram 侧审批必须在幂等守卫**之前**执行。
  // 旧实现守卫在前 —— 用户第一次申请时若审批失败回落了私聊验证（留下 pending 会话），
  // 之后每次重新申请都会被守卫直接短路返回，Telegram 侧申请永远无人批准，
  // 用户端表现就是「反复申请加群机器人完全没反应」。
  // 审批本身幂等（重复批准 Telegram 会返回 already_participant，v2.1.1 已按成功处理），
  // 先批不会产生副作用。
  //
  // 入群申请链接用户：先批准进群（群内验证的前提）；批准失败 → 回落私聊验证。
  // v2.1.1：优先由收到本次 chat_join_request 的机器人（api）执行审批 ——
  // 它必然是本群管理员（Telegram 只向群内管理员推送申请事件），不再依赖
  // 群组绑定行与主 bot token（edge 未配置主 token 时旧实现审批必败 →
  // 静默回落私聊 → 用户端「机器人完全没反应」）
  if (requestType === "telegram") {
    const approval = await approveTelegramJoinRequest(BigInt(chat.id), BigInt(user.id), api);
    if (!approval.success) {
      console.warn(
        `Group-channel join request approval failed (chat ${chat.id}, user ${user.id}): ` +
          `${approval.error ?? "unknown"} — falling back to DM verification`,
      );
      return bootstrapDmVerification(api, user, chat, requestType, runtime, groupSettings);
    }
  }

  // 幂等守卫：同一用户同群已有未完成会话（申请批准后的 chat_member 抖动/重复投递）
  // 不重复创建会话、不重复发群内消息；v2.1.5 补充「近 15 分钟已批准」守卫，
  // 拦截 webhook 迟到重投递（首次事件已走完批准→验证→批准全流程后的重试）
  const existing = await getPendingSessionForUserChat(BigInt(user.id), BigInt(chat.id));
  if (existing) {
    console.log(
      `Pending group verification already exists: user ${user.id} chat ${chat.id} ` +
        `session=${existing.token.slice(0, 8)}... — skip duplicate bootstrap`,
    );
    return {
      created: true,
      promptDelivered: true,
      method: existing.method as BootstrapResult["method"],
    };
  }
  const recentlyApproved = await wasRecentlyApprovedForUserChat(BigInt(user.id), BigInt(chat.id));
  if (recentlyApproved) {
    console.log(
      `Join request recently approved: user ${user.id} chat ${chat.id} — skip duplicate group bootstrap`,
    );
    return { created: false, promptDelivered: true, method: "none" };
  }

  // 验证方式解析（与私聊模式同一套规则：code_api 必须绑定启用中的验证方法）
  const methodId = groupSettings.methodId ?? null;
  let codeApiMethodId: bigint | null = null;
  if (groupSettings.method === "code_api" && methodId) {
    const method = await getVerificationMethod(methodId);
    if (method && method.enabled) {
      codeApiMethodId = method.id;
    }
  }
  const useSelfCode = groupSettings.method === "code_self" && !codeApiMethodId;
  const method = codeApiMethodId ? "code_api" : useSelfCode ? "code_self" : "captcha";
  const joinCode = useSelfCode ? generateJoinCode() : null;

  const verificationToken = generateVerificationToken();
  const expiresAt = new Date(
    utcnow().getTime() + (groupSettings.timeoutSeconds ?? runtime.verificationTimeout) * 1000,
  );

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

  const session = await createVerificationSession({
    token: verificationToken,
    userId: BigInt(user.id),
    chatId: BigInt(chat.id),
    expiresAt,
    method,
    expectedCode: joinCode,
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
    groupSettings,
    runtime.baseUrl,
    runtime.verificationButtonText,
  );

  return { created: true, promptDelivered: outcome.sent, method };
}

/**
 * 私聊验证模式 bootstrap（v1.1.3 旧行为，verification_channel=dm 或群组未配置时）。
 *
 * v2.1.5 幂等守卫（修复线上「私聊验证通过后又重复发送验证消息」，2026-11-08）：
 * 旧实现与群内验证不同，没有任何幂等保护 —— 同一 chat_join_request 的 webhook
 * 重投递/重复点击申请链接都会再建一个新会话并重发验证提示；若重投递发生在首次
 * 事件走完「验证通过→批准入群」之后，用户端表现就是「已收到验证成功消息，紧接着
 * 又收到一条新的验证提示」。现在两道守卫：
 * 1. 同用户同群已有未完成会话 → 不新建、不重发（/start 重发路径继续复用同一会话）；
 * 2. 近 15 分钟内该用户在该群的申请已被批准 → 验证早已完成，绝不重发验证提示。
 */
async function bootstrapDmVerification(
  api: Api,
  user: JoinVerificationUser,
  chat: JoinVerificationChat,
  requestType: "telegram" | "direct",
  runtime: RuntimeSettings,
  groupSettings: Awaited<ReturnType<typeof getGroupSettings>>,
): Promise<BootstrapResult> {
  const existingPending = await getPendingSessionForUserChat(BigInt(user.id), BigInt(chat.id));
  if (existingPending) {
    console.log(
      `Pending DM verification already exists: user ${user.id} chat ${chat.id} ` +
        `session=${existingPending.token.slice(0, 8)}... — skip duplicate bootstrap`,
    );
    return {
      created: true,
      promptDelivered: true,
      method: existingPending.method as BootstrapResult["method"],
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

  const methodId = groupSettings?.methodId ?? null;
  let codeApiMethodId: bigint | null = null;
  if (groupSettings?.enabled !== false && groupSettings?.method === "code_api" && methodId) {
    const method = await getVerificationMethod(methodId);
    if (method && method.enabled) {
      codeApiMethodId = method.id;
    }
  }

  // v1.1.7 code_self（输入验证码加群）：机器人自生成验证码 → 私聊发给用户 →
  // 用户回复输入 → 本地比对（对→approve / 错→decline / 超时→decline），
  // 无需外部卡密 API 与 WebApp，参考 Telegram 进群答题/对暗号验证方案。
  const useSelfCode =
    groupSettings?.enabled !== false &&
    groupSettings?.method === "code_self" &&
    !codeApiMethodId;
  const joinCode = useSelfCode ? generateJoinCode() : null;

  const expiresAt = new Date(
    utcnow().getTime() +
      (groupSettings?.timeoutSeconds ?? runtime.verificationTimeout) * 1000,
  );
  const verificationSession = await createVerificationSession({
    token: verificationToken,
    userId: BigInt(user.id),
    chatId: BigInt(chat.id),
    expiresAt,
    method: codeApiMethodId ? "code_api" : useSelfCode ? "code_self" : "captcha",
    expectedCode: joinCode,
  });

  if (!verificationSession) {
    console.error(`Failed to create verification session for user ${user.id} (${requestType})`);
    return { created: false, promptDelivered: false, method: "none" };
  }

  if (codeApiMethodId) {
    const promptText =
      groupSettings?.promptText ?? "🔐 请回复本消息并输入验证码完成验证";
    try {
      // stateless-question：问题消息末尾附加用户不可见的后缀（HTML 模式需转义正文），
      // 配合 force_reply 引导用户回复该消息——机器人无需关闭 Telegram 隐私模式
      // 即可在用户回复时收到验证码（群隐私开关 privacy_mode 见 group_settings）。
      // v1.1.4 修复：必须显式 parse_mode=HTML —— 后缀是
      // <a href="http://t.me/#tgcode#">&#8203;</a> 形态的隐形锚点，
      // 漏传 parse_mode 时该后缀会以原始 HTML 文本裸显给用户
      await api.sendMessage(
        user.id,
        htmlEscape(promptText) + codeQuestion.messageSuffixHTML(),
        {
          parse_mode: "HTML",
          // 隐形后缀的 t.me 链接实体不触发链接预览卡片（保持提示消息干净）
          link_preview_options: { is_disabled: true },
          reply_markup: {
            force_reply: true,
            input_field_placeholder: "输入验证码",
          },
        },
      );
      console.log(`Code verification prompt sent to user ${user.id} (${requestType})`);
      return { created: true, promptDelivered: true, method: "code_api" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("chat not found")) {
        // 用户尚未启动机器人，私聊不可达（Telegram 官方限制：bot 无法主动私聊未 /start 过的用户）。
        // 隐私红线：绝不在群里发任何消息提示。/start 时会重发验证提示；超时未验证按失效处理。
        console.warn(
          `Cannot send code prompt to user ${user.id} (${requestType}): user hasn't started bot; ` +
            "prompt will be resent when the user /starts the bot; session expires per timeout",
        );
        return { created: true, promptDelivered: false, method: "code_api" };
      }
      console.error("Failed to send code verification prompt:", error);
      return { created: true, promptDelivered: false, method: "code_api" };
    }
  }

  // v1.1.7 code_self 分支：私聊发送自生成的入群验证码（含隐形后缀 + force_reply，
  // 与 code_api 同一输码通道），验证码随会话落库，输入时本地比对
  if (useSelfCode && joinCode) {
    const promptText = groupSettings?.promptText ?? CODE_SELF_DEFAULT_PROMPT;
    const delivery = await sendCodeSelfPrompt(api, user.id, {
      promptText,
      code: joinCode,
      expiresAt,
      contextLabel: requestType,
    });
    return { created: true, promptDelivered: delivery.delivered, method: "code_self" };
  }

  const webAppUrl = `${runtime.baseUrl}/verify?token=${verificationToken}`;

  const keyboard = new InlineKeyboard().webApp(
    runtime.verificationButtonText,
    webAppUrl,
  );

  try {
    const chatTitle = htmlEscape(chat.title ?? "群组");
    const welcomeText = `欢迎加入群组${chatTitle}！请点击下方链接完成人机验证`;

    await api.sendMessage(user.id, welcomeText, { reply_markup: keyboard });
    console.log(`Verification message sent to user ${user.id} (${requestType})`);
    return { created: true, promptDelivered: true, method: "captcha" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("chat not found")) {
      console.warn(
        `Cannot send verification message to user ${user.id} (${requestType}): user hasn't started bot; ` +
          "prompt will be resent when the user /starts the bot; session expires per timeout",
      );
      return { created: true, promptDelivered: false, method: "captcha" };
    }
    console.error("Failed to send verification message:", error);
    return { created: true, promptDelivered: false, method: "captcha" };
  }
}

async function bootstrapJoinVerification(
  api: Api,
  user: JoinVerificationUser,
  chat: JoinVerificationChat,
  requestType: "telegram" | "direct",
): Promise<BootstrapResult> {
  // 真实加群事件到达：登记真实群组（chat_id / 群名），供管理后台「机器人测试」选择真实群组
  // （chat_join_request 仅出现在 supergroup，Telegram 基础群不支持入群申请）
  if (chat.type === "supergroup") {
    try {
      await registerTelegramChat({
        chatId: BigInt(chat.id),
        chatTitle: chat.title ?? null,
        botToken: api.token,
      });
    } catch (registryError) {
      console.warn("Failed to register real chat from join flow:", registryError);
    }
  }

  const runtime = await getRuntimeSettings(config);
  const groupSettings = await getGroupSettings(BigInt(chat.id));

  // v2.0.12 群内验证模式（auto=超级群自动启用 / 显式 group）：群组已配置且启用 → 群内验证
  if (
    groupSettings &&
    groupSettings.enabled !== false &&
    resolveVerificationChannel(groupSettings, chat.id) === "group"
  ) {
    return bootstrapGroupVerification(api, user, chat, requestType, runtime, groupSettings);
  }

  // 私聊验证模式（verification_channel=dm 或群组未配置）：v1.1.3 旧行为
  return bootstrapDmVerification(api, user, chat, requestType, runtime, groupSettings);
}

/** 真实加群申请（入群申请链接）：群内模式先批准进群再群内验证；私聊模式创建会话并私聊发送验证提示 */
export async function handleJoinRequest(ctx: BotContext): Promise<void> {
  if (!ctx.chatJoinRequest) {
    return;
  }
  const joinRequest = ctx.chatJoinRequest;
  const user = joinRequest.from;
  const chat = joinRequest.chat;
  console.log(
    `New join request from user ${user.id} (${user.username}) to chat ${chat.id}`,
  );
  await bootstrapJoinVerification(ctx.api, user, chat, "telegram");
}

/**
 * 直连入群防线（v1.1.3 新增，堵「普通邀请链接绕过验证直接进群」漏洞）：
 * 成员未经过本机器人审批（via_join_request=false）直接进入已启用验证的群组时，
 * 同样创建验证会话并补验证：
 * - 群内模式（默认）：在群内完成验证（禁言 + 按钮），通过解禁 / 失败超时踢出；
 * - 私聊模式（channel=dm）：私聊发送验证任务，通过落库标记 / 超时踢出；
 * - 管理员/创建者、机器人账号、经本机器人审批入群的用户不触发。
 */
export async function handleChatMemberUpdate(ctx: BotContext): Promise<void> {
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
    const cleaned = await expirePendingSessionForUserChat(
      BigInt(user.id),
      BigInt(chat.id),
    );
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

  // v2.0.13：真实直连入群一律登记真实群组（幂等，基础群也登记）——
  // 原先仅超级群登记，基础群（chat_join_request 官方不支持、只有 chat_member 事件）
  // 在线上永远无法出现在「机器人测试」群组列表与加群申请记录里
  if (chat.type === "supergroup" || chat.type === "group") {
    try {
      await registerTelegramChat({
        chatId: BigInt(chat.id),
        chatTitle: chat.title ?? null,
        botToken: ctx.api.token,
      });
    } catch (registryError) {
      console.warn("Failed to register real chat from direct join:", registryError);
    }
  }

  // 群组未启用验证（无配置 / 已停用）→ 不拦截、不验证，但仍落库加群申请记录。
  // v2.0.13 修复「edge 环境无法获取加群申请」：线上真实群组大多未在 D1 配置验证，
  // 旧逻辑在这里直接 return，一条记录不留 → /admin/join-requests 永远为空；
  // 现在所有真实入群轨迹（request_type=direct）都可追溯，管理员可手动批准/拒绝。
  const groupSettings = await getGroupSettings(BigInt(chat.id));
  if (!groupSettings || groupSettings.enabled === false) {
    try {
      const recorded = await createJoinRequest({
        userId: BigInt(user.id),
        chatId: BigInt(chat.id),
        username: user.username ?? null,
        firstName: user.first_name ?? "",
        lastName: user.last_name ?? null,
        verificationToken: generateVerificationToken(),
        requestType: "direct",
      });
      console.log(
        `Direct join into unconfigured/disabled chat ${chat.id}: join request ` +
          `${recorded ? "recorded" : "record FAILED"} for user ${user.id} ` +
          "(verification not enabled — no prompt sent, no kick)",
      );
    } catch (recordError) {
      console.error(
        `Failed to record join request for unconfigured chat ${chat.id}:`,
        recordError,
      );
    }
    return;
  }

  const channel = resolveVerificationChannel(groupSettings, chat.id);
  console.log(
    `Direct join without bot approval detected: user ${user.id} (${user.username}) ` +
      `entered chat ${chat.id} via ${memberUpdate.invite_link ? "invite link" : "manual add"} — ` +
      `starting ${channel === "group" ? "in-group" : "DM"} verification`,
  );
  await bootstrapJoinVerification(ctx.api, user, chat, "direct");
}

/** 用户离开群组时清理其未完成的验证任务（会话过期 + 加群申请置为 rejected） */
async function expirePendingSessionForUserChat(
  userId: bigint,
  chatId: bigint,
): Promise<boolean> {
  const { expirePendingSessionsForUserChat } = await import("@/database/operations");
  return expirePendingSessionsForUserChat(userId, chatId);
}
