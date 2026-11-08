import { InlineKeyboard, type Api } from "grammy";
import type { BotContext } from "../context";
import { codeQuestion } from "../verification-question";
import { CODE_SELF_DEFAULT_PROMPT } from "../verification-prompt";
import {
  getGroupSettings,
  getJoinRequestByToken,
  getVerificationSession,
  isSessionExpired,
  setSessionPromptMessage,
  resolveVerificationChannel,
  type GroupSettingsRow,
  type VerificationSessionRow,
} from "@/database/operations";
import { generateJoinCode } from "@/utils/crypto";
import { htmlEscape, userMentionHTML } from "@/utils/html";
import { muteUnverifiedMember } from "@/services/approval";
import { evaluateSubmittedCode } from "@/services/verification-flow";

/**
 * 群内验证模式（v2.0.5）—— 群内验证消息与点选交互：
 *
 * 三种验证方式的群内形态（前提：输入内容其他成员不可见）：
 * - captcha（人机验证）      → 群内消息 + URL 按钮打开 /verify 网页完成人机验证；
 * - code_api（外部卡密 API） → 群内消息 + URL 按钮打开 /verify 网页输入卡密
 *                              （网页调外部 API 校验，卡密不落入群聊）；
 * - code_self（自动验证码）   → 群内消息 + 4 选 1 数字按钮（callback 提交，
 *                              其他成员仅看到候选码按钮，点击结果只有机器人可见）。
 *
 * 群内默认绝不提供「回复消息明文输码」通道（code-input.ts 已硬性拦截），
 * 所有用户输入都发生在网页或 callback payload 里，群成员全程不可见。
 *
 * v2.1.5 受控例外：群设置开启 reply_code_in_group（群内回复输码快速验证）且
 * 方式为 code_self/code_api 时，群内提示改为 force_reply 形态（送达即自动聚焦
 * 输入框进入回复态），用户回复输码 —— 该模式下不禁言（输码需要发言权限），
 * 验证结束/失败后自动删除验证提示与验证码消息（机器人需具备「删除消息」权限）。
 */

/** code_self 4 选 1 按钮的 callback_data 前缀：vs:{token}:{choice} */
export const CODE_SELF_CALLBACK_PREFIX = "vs:";

/** code_self 候选按钮数量（1 正确 + 3 干扰） */
const CODE_SELF_CHOICES = 4;

/**
 * v2.1.5 群内回复输码模式的判定：群设置开启 reply_code_in_group 且方式为
 * code_self/code_api（captcha 必须在验证网页完成，无回复输码形态）。
 */
export function isGroupReplyInputMode(
  settings: GroupSettingsRow | null,
  method: string,
): boolean {
  return (
    settings?.replyCodeInGroup === true &&
    (method === "code_self" || method === "code_api")
  );
}

export function isCodeSelfCallbackData(data: string): boolean {
  return data.startsWith(CODE_SELF_CALLBACK_PREFIX) && data.split(":").length === 3;
}

interface JoinPromptUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface JoinPromptChat {
  id: number;
  title?: string;
}

/** 按验证方式组装群内提示正文（HTML，提及新成员并说明不可见性） */
function buildGroupPromptHTML(
  method: string,
  user: JoinPromptUser,
  chatTitle: string,
  timeoutSeconds: number,
): string {
  const minutes = Math.max(1, Math.round(timeoutSeconds / 60));
  const mention = userMentionHTML(user);
  const title = htmlEscape(chatTitle);
  switch (method) {
    case "captcha":
      return (
        `👋 欢迎 ${mention} 加入「${title}」！\n\n` +
        `请在 ${minutes} 分钟内点击下方按钮完成人机验证，验证通过前你将无法发言。\n\n` +
        "🔒 验证过程在验证页面完成，群里其他成员不可见。"
      );
    case "code_api":
      return (
        `👋 欢迎 ${mention} 加入「${title}」！\n\n` +
        `请在 ${minutes} 分钟内点击下方按钮，在打开的页面中输入验证码完成验证，验证通过前你将无法发言。\n\n` +
        "🔒 验证码在验证页面输入，群里其他成员不可见。"
      );
    case "code_self":
      return (
        `👋 欢迎 ${mention} 加入「${title}」！\n\n` +
        `请在 ${minutes} 分钟内点击下方按钮，从 4 个候选验证码中点选正确的一项完成验证，验证通过前你将无法发言。\n\n` +
        "🔒 点选结果仅机器人可见，群里其他成员不可见。"
      );
    default:
      return (
        `👋 欢迎 ${mention} 加入「${title}」！\n\n` +
        `请在 ${minutes} 分钟内点击下方按钮完成验证，验证通过前你将无法发言。\n\n` +
        "🔒 验证过程群里其他成员不可见。"
      );
  }
}

/** 生成 code_self 候选按钮：1 个正确码（会话落库的 expectedCode）+ 3 个互不相同的干扰码 */
function buildCodeSelfChoices(correct: string): string[] {
  const choices = new Set<string>([correct]);
  let guard = 0;
  while (choices.size < CODE_SELF_CHOICES && guard < 200) {
    guard += 1;
    const decoy = generateJoinCode(correct.length);
    choices.add(decoy);
  }
  // 干扰码生成理论上可能撞车（生成空间 9*10^(n-1) 足够大，200 次兜底后仍不足则补随机数）
  while (choices.size < CODE_SELF_CHOICES) {
    choices.add(String(Date.now() % 1000000).padStart(correct.length, "0"));
  }
  return Array.from(choices).sort(() => Math.random() - 0.5);
}

/**
 * v2.1.5 群内回复输码快速提示（reply_code_in_group=true 且 code_self/code_api）：
 * 与私聊验证同一交互形态 —— force_reply 提示（送达即自动聚焦输入框进入回复态，
 * 用户无需点击任何按钮即可直接输码），提示正文带 stateless-question 隐形后缀，
 * 用户回复该消息时机器人即可收到验证码（Telegram 隐私模式开启的群组同样可用：
 * 「回复机器人消息」始终可达）。
 *
 * code_self：提示内直接展示一次性验证码（用户明确接受输码在群内短暂可见）；
 * code_api：用户输入自己持有的外部卡密（验证码本身不落群聊）。
 * 验证结束/失败/超时后机器人自动删除验证提示与验证码消息（code-input.ts /
 * approval.ts 协同，需机器人具备「删除消息」管理员权限，失败 best effort）。
 */
function buildGroupReplyPromptHTML(
  session: VerificationSessionRow,
  settings: GroupSettingsRow,
  user: JoinPromptUser,
  chatTitle: string,
  timeoutSeconds: number,
): string {
  const minutes = Math.max(1, Math.round(timeoutSeconds / 60));
  const mention = userMentionHTML(user);
  const title = htmlEscape(chatTitle);
  const promptText = htmlEscape(settings.promptText ?? CODE_SELF_DEFAULT_PROMPT);
  const codeLine =
    session.method === "code_self" && session.expectedCode
      ? `\n\n您的入群验证码：<b>${htmlEscape(session.expectedCode)}</b>`
      : "";
  return (
    `👋 欢迎 ${mention} 加入「${title}」！\n\n` +
    promptText +
    codeLine +
    "\n\n" +
    `⏱ 验证码 ${minutes} 分钟内有效：输入框已自动定位到回复本消息，直接输入验证码发送即可。` +
    "\n🧹 验证结束后机器人将自动删除本提示与验证码消息。" +
    codeQuestion.messageSuffixHTML()
  );
}

export interface GroupPromptOutcome {
  /** 提示消息是否成功发送到群内 */
  sent: boolean;
  /** 群内提示消息 id（成功时回写会话，供验证结束/超时后删除） */
  messageId: number | null;
}

/**
 * 群内验证 bootstrap 的发送阶段：禁言 + 群内验证消息（按方式组装按钮）。
 *
 * v2.1.5 群内回复输码模式（reply_code_in_group=true 且 code_self/code_api）：
 * 用户需在群内回复提示输码 —— 禁言会导致无法发言，该模式**不禁言**，提示改为
 * force_reply 形态（无按钮）；captcha 仍走网页按钮，code_self 默认仍走 4 选 1。
 *
 * 禁言失败（机器人无「限制成员」权限）不阻塞验证：提示照发，超时/失败仍会尝试踢出；
 * 提示发送失败（机器人被移出群/无发言权限）返回 sent=false，由调用方记录日志——
 * 会话仍然存在，超时清理会按既定逻辑处理。
 */
export async function muteAndSendGroupPrompt(
  api: Api,
  chat: JoinPromptChat,
  user: JoinPromptUser,
  session: VerificationSessionRow,
  settings: GroupSettingsRow | null,
  webAppBaseUrl: string,
  verifyButtonText: string,
): Promise<GroupPromptOutcome> {
  // v2.1.5 群内回复输码模式：不禁言（禁言成员无法在群内发言/回复输码）
  const replyInputMode = isGroupReplyInputMode(settings, session.method);

  // 1. 禁言（验证通过前无法发言；until_date 已在服务内做 30s~366d 边界钳制）
  // v2.1.1：禁言也由事件接收 bot（api）执行，不再依赖绑定行/主 bot token
  if (!replyInputMode) {
    await muteUnverifiedMember(BigInt(chat.id), BigInt(user.id), session.expiresAt, api);
  } else {
    console.log(
      `Group reply-input mode enabled: user ${user.id} chat ${chat.id} method=${session.method} — skip mute (member must be able to reply)`,
    );
  }

  // 2. 组装键盘/提示形态：回复输码 → force_reply 提示（无按钮）；
  //    code_self 默认 → 4 选 1；captcha/code_api 默认 → URL 按钮打开验证网页
  let replyMarkup: InlineKeyboard | undefined;
  let html: string;
  if (replyInputMode && settings) {
    html = buildGroupReplyPromptHTML(
      session,
      settings,
      user,
      chat.title ?? "群组",
      Math.max(30, Math.round((session.expiresAt.getTime() - Date.now()) / 1000)),
    );
  } else if (session.method === "code_self" && session.expectedCode) {
    const choices = buildCodeSelfChoices(session.expectedCode);
    const keyboard = new InlineKeyboard();
    choices.forEach((choice, index) => {
      keyboard.text(`🔐 ${choice}`, `${CODE_SELF_CALLBACK_PREFIX}${session.token}:${choice}`);
      if (index % 2 === 1) keyboard.row();
    });
    replyMarkup = keyboard;
    html = buildGroupPromptHTML(
      session.method,
      user,
      chat.title ?? "群组",
      Math.max(30, Math.round((session.expiresAt.getTime() - Date.now()) / 1000)),
    );
  } else {
    const verifyUrl = `${webAppBaseUrl.replace(/\/$/, "")}/verify?token=${session.token}`;
    replyMarkup = new InlineKeyboard().url(verifyButtonText || "验证", verifyUrl);
    html = buildGroupPromptHTML(
      session.method,
      user,
      chat.title ?? "群组",
      Math.max(30, Math.round((session.expiresAt.getTime() - Date.now()) / 1000)),
    );
  }

  try {
    const message = await api.sendMessage(chat.id, html, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
    await setSessionPromptMessage(session.token, message.message_id);
    console.log(
      `Group verification prompt sent: user ${user.id} chat ${chat.id} method=${session.method} message=${message.message_id}${replyInputMode ? " (reply-input mode)" : ""}`,
    );
    return { sent: true, messageId: message.message_id };
  } catch (error) {
    console.error(`Failed to send group verification prompt to chat ${chat.id}:`, error);
    return { sent: false, messageId: null };
  }
}

/**
 * code_self 4 选 1 点选回调处理器（callback_query:data）。
 *
 * 注册在菜单插件之后：非本模块的 callback（菜单/其他）原样放行 next()，
 * 仅消费 vs: 前缀数据。校验链：会话有效 → 点击者必须是会话本人（防代点）→
 * 统一校验管道 evaluateSubmittedCode（尝试次数/失效/群内踢出/解禁/欢迎全复用）。
 */
export async function handleVerificationChoice(
  ctx: BotContext,
  next?: () => Promise<void>,
): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  if (!isCodeSelfCallbackData(data)) {
    await next?.();
    return;
  }

  const [, token, choice] = data.split(":");
  const from = ctx.from;
  if (!from || from.is_bot || !token || !choice) {
    await ctx.answerCallbackQuery({ text: "验证数据异常" });
    return;
  }

  const session = await getVerificationSession(token);
  if (
    !session ||
    session.method !== "code_self" ||
    session.captchaCompleted ||
    isSessionExpired(session)
  ) {
    await ctx.answerCallbackQuery({ text: "⏰ 验证已失效，请重新申请加群" });
    return;
  }

  // 防代点：只有会话本人点按有效（其他成员点击不消耗次数、不产生任何副作用）
  if (Number(session.userId) !== from.id) {
    await ctx.answerCallbackQuery({ text: "这不是你的验证任务，无法代为点选" });
    return;
  }

  const joinRequest = await getJoinRequestByToken(token);
  if (!joinRequest || joinRequest.status !== "pending") {
    await ctx.answerCallbackQuery({ text: "⏰ 验证已失效，请重新申请加群" });
    return;
  }

  const settings = await getGroupSettings(session.chatId);
  // v2.0.12 三态：auto 按群 chat_id 判定（同一群判定结果恒定，与 bootstrap 一致）；
  // 显式配置被切换时旧会话失效要求重新申请
  if (resolveVerificationChannel(settings, session.chatId) !== "group") {
    await ctx.answerCallbackQuery({ text: "验证渠道已切换，请重新申请加群" });
    return;
  }

  // 统一校验管道：正确 → completeGroupVerification（落库批准 + 解禁 + 删提示 + 群内欢迎）；
  // 错误 → 计次 / 次数用尽 → 失效 + 踢出 + 删提示（verification-flow 群内分支）
  const result = await evaluateSubmittedCode({
    userId: BigInt(from.id),
    username: from.username ?? null,
    code: choice,
    preloaded: { session, joinRequest, settings },
  });

  switch (result.outcome) {
    case "success":
      await ctx.answerCallbackQuery({ text: "✅ 验证通过，欢迎加入！" });
      break;
    case "failed_retry":
      await ctx.answerCallbackQuery({
        text: `❌ 验证码错误，剩余 ${result.remaining ?? 0} 次机会`,
        show_alert: true,
      });
      break;
    case "failed_expired":
      // v2.0.7：直连用户踢出开关关闭时保留在群内 —— 文案与实际动作一致
      await ctx.answerCallbackQuery({
        text: result.stayedInGroup
          ? "❌ 尝试次数已用完，本次验证已失效（你仍保留在群组中）"
          : "❌ 尝试次数已用完，你已被移出群组",
        show_alert: true,
      });
      break;
    case "network_error":
      await ctx.answerCallbackQuery({ text: "🌐 网络波动，本次未消耗次数，请稍后再试" });
      break;
    default:
      await ctx.answerCallbackQuery({
        text: result.replyText || "验证状态异常，请重新申请加群",
      });
  }
  console.log(
    `Code self choice processed: user ${from.id} chat ${session.chatId} outcome=${result.outcome}`,
  );
}

// v2.0.7 说明：原 cleanupGroupVerificationFailure（无条件踢出版善后函数）已删除 ——
// 失效善后统一走 verification-flow.ts evaluateSubmittedCode 的失败分支
// （按 group_settings.kick_direct_joins 开关决策踢出/保留，避免旁路绕过开关）。
