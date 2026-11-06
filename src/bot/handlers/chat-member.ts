import type { BotContext } from "../context";
import { config } from "@/config/settings";
import { getRuntimeSettings } from "@/config/runtime-settings";
import {
  createJoinRequest,
  createVerificationSession,
  getGroupSettings,
  getPendingSessionForUserChat,
  getVerificationMethod,
} from "@/database/operations";
import { generateVerificationToken, generateJoinCode } from "@/utils/crypto";
import { htmlEscape } from "@/utils/html";
import { utcnow } from "@/utils/time";
import { InlineKeyboard, type Api } from "grammy";
import { codeQuestion } from "../verification-question";
import { CODE_SELF_DEFAULT_PROMPT, sendCodeSelfPrompt } from "../verification-prompt";
import { registerTelegramChat } from "@/services/chat-registry";
import {
  buildOptionCodes,
  isGroupChannel,
  memberDisplayName,
  muteGroupMember,
  resolveVerifyUrl,
  sendGroupVerificationPrompt,
} from "@/services/group-verification";

/**
 * 加群验证引导（真实 Telegram 路径，v2.1.0 起默认群内验证）：
 *
 * 两条入口共用同一核心 bootstrapJoinVerification：
 * 1. chat_join_request —— 用户通过「入群申请链接」申请加群（需要机器人审批，入群前验证）
 * 2. chat_member       —— 用户通过普通邀请链接/被拉入群直接进来了（入群后补验证，超时/失败踢出）
 *
 * 渠道分流（group_settings.verify_channel）：
 * - group（默认，真实流程）：自动批准进群 → 立即禁言 → 群内发验证消息（mention + 倒计时 + 按钮）
 *   → 通过则解禁 + 删除群内提示 + 群内欢迎；失败/超时则删提示 + 群内告知 + 踢出；
 *   群聊明文输码被硬性拦截（见 handlers/code-input.ts），其他成员看不到任何输入内容。
 * - dm（旧版行为，逐字保留）：所有验证提示/结果只通过机器人私聊发送，群组内零消息。
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
  /** 验证提示是否已成功送达（group 渠道=群内消息，dm 渠道=私聊） */
  promptDelivered: boolean;
  method: "code_api" | "code_self" | "captcha" | "none";
  /** 本次会话使用的验证渠道（group=群内验证 / dm=私聊验证） */
  channel: "group" | "dm";
}

/** 群内渠道：自动批准加群申请（apply 失败不阻塞 —— 用户可能已在群内） */
async function autoApproveJoinRequest(
  api: Api,
  chatId: number,
  userId: number,
  requestType: string,
): Promise<boolean> {
  if (requestType !== "telegram") return false;
  try {
    await api.approveChatJoinRequest(chatId, userId);
    console.log(`[group-verify] 自动批准入群: user=${userId} chat=${chatId}`);
    return true;
  } catch (error) {
    // 400 = 申请已被处理/已不存在（用户重复点击申请链接等），属正常竞态
    console.warn(
      `[group-verify] 自动批准入群失败（可能申请已被处理）: user=${userId} chat=${chatId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
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
    return { created: false, promptDelivered: false, method: "none", channel: "dm" };
  }

  const groupSettings = await getGroupSettings(BigInt(chat.id));
  const methodId = groupSettings?.methodId ?? null;
  let codeApiMethodId: bigint | null = null;
  if (groupSettings?.enabled !== false && groupSettings?.method === "code_api" && methodId) {
    const method = await getVerificationMethod(methodId);
    if (method && method.enabled) {
      codeApiMethodId = method.id;
    }
  }

  // v1.1.7 code_self（输入验证码加群）：机器人自生成验证码 →
  // 私聊发给用户（dm 渠道）或作为群内 4 选 1 候选按钮（group 渠道）
  const useSelfCode =
    groupSettings?.enabled !== false &&
    groupSettings?.method === "code_self" &&
    !codeApiMethodId;
  const joinCode = useSelfCode ? generateJoinCode() : null;
  const method: "code_api" | "code_self" | "captcha" = codeApiMethodId
    ? "code_api"
    : useSelfCode
      ? "code_self"
      : "captcha";

  // 渠道判定：无群组配置（未配置验证）时保持旧私聊行为；
  // captcha / code_api 在群内渠道依赖网页验证页，Base URL 缺失时降级为私聊
  let channel: "group" | "dm" = isGroupChannel(groupSettings) ? "group" : "dm";
  let verifyUrl: string | null = null;
  if (channel === "group") {
    if (method === "code_self") {
      verifyUrl = null;
    } else {
      verifyUrl = await resolveVerifyUrl(verificationToken);
      if (!verifyUrl) {
        console.warn(
          `[group-verify] 系统 Base URL 未配置，群内渠道无法生成验证页链接 → 本会话降级为私聊验证: chat=${chat.id}`,
        );
        channel = "dm";
      }
    }
  }

  // 群内渠道必须先让用户真正进群（自动批准入群申请），否则群里没有任何可交互对象。
  // 批准失败（机器人缺「邀请用户」权限 / 申请已被处理 / 用户已自行进群）时：
  // - 申请类用户并未在群内 → 本会话降级为私聊渠道（否则用户既看不到群消息也无法验证，
  //   超时还会去踢一个不在群里的人）；
  // - 直连入群用户本来就在群里，无需批准。
  if (channel === "group" && requestType === "telegram") {
    const approved = await autoApproveJoinRequest(api, chat.id, user.id, requestType);
    if (!approved) {
      console.warn(
        `[group-verify] 自动批准失败 → 本会话降级为私聊验证（用户未进群，群内验证无从进行）: user=${user.id} chat=${chat.id}`,
      );
      channel = "dm";
    }
  }

  const optionCodes =
    channel === "group" && method === "code_self" && joinCode
      ? buildOptionCodes(joinCode)
      : null;

  const expiresAt = new Date(
    utcnow().getTime() +
      (groupSettings?.timeoutSeconds ?? runtime.verificationTimeout) * 1000,
  );
  const verificationSession = await createVerificationSession({
    token: verificationToken,
    userId: BigInt(user.id),
    chatId: BigInt(chat.id),
    expiresAt,
    method,
    expectedCode: joinCode,
    channel,
    optionCodes,
  });

  if (!verificationSession) {
    console.error(`Failed to create verification session for user ${user.id} (${requestType})`);
    return { created: false, promptDelivered: false, method: "none", channel };
  }

  // —— 群内验证（默认真实流程）——
  if (channel === "group") {
    const muted = await muteGroupMember(BigInt(chat.id), BigInt(user.id));
    if (!muted) {
      console.warn(
        `[group-verify] 未成功禁言 user=${user.id} chat=${chat.id}：机器人需具备「限制成员」权限；验证流程继续`,
      );
    }
    const delivery = await sendGroupVerificationPrompt(api, {
      chatId: BigInt(chat.id),
      userId: BigInt(user.id),
      displayName: memberDisplayName(user),
      chatTitle: chat.title ?? null,
      token: verificationToken,
      method,
      expiresAt,
      optionCodes,
      verifyUrl,
    });
    if (!delivery.delivered) {
      // 群内提示发不出去（机器人被禁言/无发言权限）：退化为私聊提示，避免用户无从下手。
      // 会话渠道仍为 group（结果收口必须是解禁/踢出语义，而不是「批准加群申请」）。
      // code_self 的私聊兜底必须带上验证码：群里没有按钮可点，用户只能在私聊里回输
      // （私聊不属于「群聊明文输码」，硬拦截只作用于群聊文本）。
      const minutes = Math.max(1, Math.round((expiresAt.getTime() - Date.now()) / 60000));
      const fallbackText =
        method === "code_self" && joinCode
          ? `您的入群验证码：<b>${htmlEscape(joinCode)}</b>\n请直接回复本对话输入该验证码完成验证（群内验证消息发送失败，本条私聊为兜底通道）。\n⏱ ${minutes} 分钟内有效。`
          : `🔐 请打开验证页面完成验证：${verifyUrl ?? ""}\n⏱ ${minutes} 分钟内有效。`;
      try {
        await api.sendMessage(
          user.id,
          `⚠️ 群内验证消息发送失败（机器人可能被限制发言）。
${fallbackText}
若无法完成，请联系群管理员。`,
          { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
        );
      } catch (dmError) {
        console.warn(
          `[group-verify] 群内提示与私聊兜底均失败，等待超时清理: user=${user.id}: ${
            dmError instanceof Error ? dmError.message : String(dmError)
          }`,
        );
      }
    }
    return { created: true, promptDelivered: delivery.delivered, method, channel };
  }

  // —— 以下为私聊渠道（v1.1.3 ~ v1.1.7 原有行为，逐字保留）——
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
      return { created: true, promptDelivered: true, method: "code_api", channel };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("chat not found")) {
        // 用户尚未启动机器人，私聊不可达（Telegram 官方限制：bot 无法主动私聊未 /start 过的用户）。
        // 隐私红线：绝不在群里发任何消息提示。/start 时会重发验证提示；超时未验证按失效处理。
        console.warn(
          `Cannot send code prompt to user ${user.id} (${requestType}): user hasn't started bot; ` +
            "prompt will be resent when the user /starts the bot; session expires per timeout",
        );
        return { created: true, promptDelivered: false, method: "code_api", channel };
      }
      console.error("Failed to send code verification prompt:", error);
      return { created: true, promptDelivered: false, method: "code_api", channel };
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
    return { created: true, promptDelivered: delivery.delivered, method: "code_self", channel };
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
    return { created: true, promptDelivered: true, method: "captcha", channel };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("chat not found")) {
      console.warn(
        `Cannot send verification message to user ${user.id} (${requestType}): user hasn't started bot; ` +
          "prompt will be resent when the user /starts the bot; session expires per timeout",
      );
      return { created: true, promptDelivered: false, method: "captcha", channel };
    }
    console.error("Failed to send verification message:", error);
    return { created: true, promptDelivered: false, method: "captcha", channel };
  }
}

/** 真实加群申请（入群申请链接）：创建验证会话并私聊发送验证提示 */
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
 * 同样创建验证会话并私聊发送验证任务：
 * - 验证成功：用户已在群内，无需 Telegram 审批，仅私聊祝贺并落库标记通过；
 * - 验证失败（尝试次数用尽）或超时未验证：踢出群组（ban+unban），私聊引导重新申请；
 * - 群组内零消息；管理员/创建者、机器人账号、经本机器人审批入群的用户不触发。
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

  // 群组未启用验证（无配置 / 已停用）→ 不拦截
  const groupSettings = await getGroupSettings(BigInt(chat.id));
  if (!groupSettings || groupSettings.enabled === false) {
    return;
  }

  // v2.1.0 防重复 bootstrap：群内渠道「自动批准 + 禁言」会再触发一次 chat_member
  // （member→restricted），若不守卫会对同一用户重复建会话、重复发群内验证消息
  const pendingSession = await getPendingSessionForUserChat(
    BigInt(user.id),
    BigInt(chat.id),
  );
  if (pendingSession) {
    console.log(
      `Skip duplicate verification bootstrap: user ${user.id} already has pending session in chat ${chat.id}`,
    );
    return;
  }

  console.log(
    `Direct join without bot approval detected: user ${user.id} (${user.username}) ` +
      `entered chat ${chat.id} via ${memberUpdate.invite_link ? "invite link" : "manual add"} — starting verification`,
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
