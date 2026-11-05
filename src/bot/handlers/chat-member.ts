import type { BotContext } from "../context";
import { config } from "@/config/settings";
import { getRuntimeSettings } from "@/config/runtime-settings";
import {
  createJoinRequest,
  createVerificationSession,
  expireVerificationSession,
  getGroupSettings,
  getVerificationMethod,
  rejectJoinRequest,
} from "@/database/operations";
import { generateVerificationToken, generateJoinCode } from "@/utils/crypto";
import { htmlEscape } from "@/utils/html";
import { utcnow } from "@/utils/time";
import { InlineKeyboard, type Api } from "grammy";
import { codeQuestion } from "../verification-question";
import { CODE_SELF_DEFAULT_PROMPT, sendCodeSelfPrompt } from "../verification-prompt";
import { registerTelegramChat } from "@/services/chat-registry";

/**
 * 加群验证引导（真实 Telegram 路径，v1.1.3 重构）：
 *
 * 两条入口共用同一核心 bootstrapJoinVerification：
 * 1. chat_join_request —— 用户通过「入群申请链接」申请加群（需要机器人审批，入群前验证）
 * 2. chat_member       —— 用户通过普通邀请链接/被拉入群直接进来了（入群后补验证，超时/失败踢出）
 *
 * 隐私红线（v1.1.3）：所有验证提示/结果只通过机器人私聊发送，群组内绝不发送任何验证消息。
 * 私聊发送失败（用户尚未启动机器人）时仅记录日志：
 * - 申请类用户：之后点「开始」时 /start 会重发验证提示（pending 会话仍在）；
 * - 直连入群用户：验证超时后由清理任务自动踢出，可重新申请。
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
  /** 验证提示是否已成功送达用户私聊 */
  promptDelivered: boolean;
  method: "code_api" | "code_self" | "captcha" | "none";
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
    return { created: false, promptDelivered: false, method: "none" };
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

  console.log(
    `Direct join without bot approval detected: user ${user.id} (${user.username}) ` +
      `entered chat ${chat.id} via ${memberUpdate.invite_link ? "invite link" : "manual add"} — starting DM verification`,
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
