import type { Api } from "grammy";
import { InlineKeyboard } from "grammy";
import { config } from "@/config/settings";
import { getRuntimeSettings } from "@/config/runtime-settings";
import {
  approveJoinRequest,
  expireVerificationSession,
  getGroupSettings,
  getJoinRequestByToken,
  getVerificationSession,
  rejectJoinRequest,
  setSessionGroupMessageId,
  type GroupSettingsRow,
  type JoinRequestRow,
  type VerificationSessionRow,
} from "@/database/operations";
import { resolveBotForChat } from "./approval";
import { htmlEscape } from "@/utils/html";

/**
 * 群内验证（v2.1.0，默认真实流程）：
 *
 * 申请加群 → 自动批准进群（join_requests.status 保持 pending，供超时清理判断）
 *   → 进群立即禁言（机器人无「限制成员」权限则跳过，不阻塞流程）
 *   → 群内发验证消息（mention 新成员 + 倒计时 + 按钮）
 *   → 通过：解禁 + 删除群内验证消息 + 群内欢迎
 *   → 失败 / 超时：删除提示 + 群内告知 + 踢出（可重新申请）
 *
 * 「不可见」的三种实现（前提条件：其他群成员看不到用户输入的内容）：
 * 1. 人机验证 / 外部 API 卡密：群内 URL 按钮 → 打开 /verify 网页输码（网页内容群友看不见）
 * 2. 自动验证码：群内 4 选 1 数字按钮（callback 提交，群友只看到候选按钮）
 * 3. 群聊明文输码：硬性拦截（handleCodeInput 直接忽略，见 handlers/code-input.ts）
 *
 * 本模块只做「群消息/权限」这一层动作，文案与判定分别由
 * verification-flow（判定）与 chat-member（bootstrap）负责。
 */

/** 禁言/解禁所需的完整权限位（use_independent_chat_permissions 语义） */
const NO_PERMISSIONS = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
  can_change_info: false,
  can_invite_users: false,
  can_pin_messages: false,
  can_manage_topics: false,
} as const;

const ALL_PERMISSIONS = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
  can_change_info: false,
  can_invite_users: false,
  can_pin_messages: false,
  can_manage_topics: false,
} as const;

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 群内展示用的成员名（mention 链接文本，HTML 转义由调用方处理） */
export function memberDisplayName(input: {
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
}): string {
  const full = `${input.firstName ?? ""} ${input.lastName ?? ""}`.trim();
  if (full) return full;
  if (input.username) return `@${input.username}`;
  return "新成员";
}

/** HTML mention：<a href="tg://user?id=123">名字</a> */
export function memberMentionHTML(userId: number | bigint, name: string): string {
  return `<a href="tg://user?id=${String(userId)}">${htmlEscape(name)}</a>`;
}

/**
 * 群内 4 选 1 候选码（v2.1.0 code_self 群内形态）：
 * 正确码 + 3 个等长干扰码（互不相同、与正确码不同），随机打乱顺序 ——
 * 群友只能看到 4 个候选数字，点没点对只有机器人知道（正确码仅在会话里）。
 */
export function buildOptionCodes(correctCode: string, total = 4): string[] {
  const length = correctCode.length;
  const codes = new Set<string>([correctCode]);
  let guard = 0;
  while (codes.size < total && guard < 200) {
    guard += 1;
    let candidate = "";
    for (let i = 0; i < length; i += 1) {
      candidate += String(Math.floor(Math.random() * 10));
    }
    if (candidate !== correctCode && candidate.length === length) codes.add(candidate);
  }
  const list = [...codes];
  // Fisher–Yates 洗牌（Math.random 即可：仅用于打乱展示顺序，不承担安全随机职责）
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j]!, list[i]!];
  }
  return list;
}

/** 剩余有效分钟数（至少 1，避免显示「0 分钟内有效」） */
export function remainingMinutes(expiresAt: Date): number {
  return Math.max(1, Math.round((expiresAt.getTime() - Date.now()) / 60000));
}

// ---------------------------------------------------------------------------
// 群成员权限（禁言 / 解禁）
// ---------------------------------------------------------------------------

/** 进群立即禁言。返回 false 表示未执行（机器人缺「限制成员」权限等），由调用方记录但不阻塞流程 */
export async function muteGroupMember(chatId: bigint, userId: bigint): Promise<boolean> {
  try {
    const bot = await resolveBotForChat("muteGroupMember", chatId, userId);
    await bot.api.restrictChatMember(Number(chatId), Number(userId), {
      ...NO_PERMISSIONS,
    }, { use_independent_chat_permissions: true });
    console.log(`[group-verify] muted user ${userId} in chat ${chatId}`);
    return true;
  } catch (error) {
    console.warn(
      `[group-verify] 禁言失败（机器人可能缺少「限制成员」权限），跳过禁言继续流程: user=${userId} chat=${chatId}: ${describeError(error)}`,
    );
    return false;
  }
}

/** 验证通过解禁（恢复发言权限）；未禁言成功时此调用失败属正常，静默记录 */
export async function unmuteGroupMember(chatId: bigint, userId: bigint): Promise<boolean> {
  try {
    const bot = await resolveBotForChat("unmuteGroupMember", chatId, userId);
    await bot.api.restrictChatMember(Number(chatId), Number(userId), {
      ...ALL_PERMISSIONS,
    }, { use_independent_chat_permissions: true });
    console.log(`[group-verify] unmuted user ${userId} in chat ${chatId}`);
    return true;
  } catch (error) {
    console.warn(
      `[group-verify] 解禁失败（可能本就未被禁言或权限不足）: user=${userId} chat=${chatId}: ${describeError(error)}`,
    );
    return false;
  }
}

/** 删除群内验证消息（提示/结果）；失败仅记录（消息可能已被用户或管理员删除） */
export async function deleteGroupMessage(
  chatId: bigint,
  userId: bigint,
  messageId: number | null,
): Promise<boolean> {
  if (!messageId) return false;
  try {
    const bot = await resolveBotForChat("deleteGroupMessage", chatId, userId);
    await bot.api.deleteMessage(Number(chatId), messageId);
    return true;
  } catch (error) {
    console.warn(
      `[group-verify] 删除群内验证消息失败（可能已过期/已删除）: message=${messageId}: ${describeError(error)}`,
    );
    return false;
  }
}

/** 向群内发送一条提示（群内告知）；失败仅记录，不影响主流程 */
export async function sendGroupNotice(
  chatId: bigint,
  userId: bigint,
  html: string,
): Promise<boolean> {
  try {
    const bot = await resolveBotForChat("sendGroupNotice", chatId, userId);
    await bot.api.sendMessage(Number(chatId), html, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    return true;
  } catch (error) {
    console.warn(
      `[group-verify] 群内提示发送失败: chat=${chatId}: ${describeError(error)}`,
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// 群内验证提示
// ---------------------------------------------------------------------------

export interface GroupPromptParams {
  chatId: bigint;
  userId: bigint;
  displayName: string;
  chatTitle: string | null;
  token: string;
  method: string;
  expiresAt: Date;
  /** code_self：4 选 1 候选数字（含正确码） */
  optionCodes: string[] | null;
}

/**
 * 组装群内验证消息正文（HTML）。
 *
 * 群内文案刻意不复用 group_settings.prompt_text（那条是「请回复本消息并输入验证码」的
 * 私聊文案，直接贴到群里会引导成员在群聊里输码，与「群内不得明文输码」的前提冲突）。
 */
export function buildGroupPromptHTML(params: GroupPromptParams): string {
  const minutes = remainingMinutes(params.expiresAt);
  const who = memberMentionHTML(params.userId, params.displayName);
  const title = params.chatTitle ? `<b>${htmlEscape(params.chatTitle)}</b>` : "本群";
  const lines = [`👋 ${who}，欢迎加入 ${title}！`, ""];
  if (params.method === "code_self") {
    lines.push("🔐 请点击下面与你收到的验证码相符的数字按钮完成验证（点错会消耗一次尝试机会）。");
  } else {
    lines.push(
      "🔐 请点击下方「打开验证页面」按钮，在网页中输入验证码完成验证 —— 网页内容只有你和机器人可见，其他群成员看不到。",
    );
  }
  lines.push(`⏱ 请在 ${minutes} 分钟内完成，超时未验证将被移出群组。`);
  lines.push("");
  lines.push("⚠️ 请勿在群聊里直接发送验证码（机器人不会处理群聊中的明文验证码）。");
  return lines.join("\n");
}

/**
 * 群内提示的纯文本版本（仿真屏展示 / 私聊兜底文案用）。
 * 与 buildGroupPromptHTML 同一套措辞，只是把 HTML mention 换成「名字」。
 */
export function buildGroupPromptPlainText(params: Omit<GroupPromptParams, "token">): string {
  const minutes = remainingMinutes(params.expiresAt);
  const lines = [
    `👋 ${params.displayName}，欢迎加入 ${params.chatTitle ?? "本群"}！`,
    "",
  ];
  if (params.method === "code_self") {
    lines.push("🔐 请点击下面与你收到的验证码相符的数字按钮完成验证（点错会消耗一次尝试机会）。");
  } else {
    lines.push(
      "🔐 请点击下方「打开验证页面」按钮，在网页中输入验证码完成验证 —— 网页内容只有你和机器人可见，其他群成员看不到。",
    );
  }
  lines.push(`⏱ 请在 ${minutes} 分钟内完成，超时未验证将被移出群组。`);
  lines.push("");
  lines.push("⚠️ 请勿在群聊里直接发送验证码（机器人不会处理群聊中的明文验证码）。");
  return lines.join("\n");
}

/** 群内验证按钮：code_self → 4 选 1 callback；其余 → /verify 网页 URL */
export function buildGroupPromptKeyboard(params: {
  token: string;
  method: string;
  optionCodes: string[] | null;
  verifyUrl: string | null;
}): InlineKeyboard | undefined {
  if (params.method === "code_self") {
    const options = params.optionCodes ?? [];
    if (options.length === 0) return undefined;
    const keyboard = new InlineKeyboard();
    options.forEach((code, index) => {
      // callback_data: vg:<token>:<index>（token 32 位 + 前缀 = 36 字节，安全低于 64 字节上限）
      keyboard.text(code, `vg:${params.token}:${index}`);
      if (index % 2 === 1) keyboard.row();
    });
    return keyboard;
  }
  if (!params.verifyUrl) return undefined;
  return new InlineKeyboard().url("🔐 打开验证页面", params.verifyUrl);
}

export interface GroupPromptDelivery {
  delivered: boolean;
  messageId: number | null;
  /** 失败原因（用于诊断；不向上抛出，避免打断已完成的入群/禁言动作） */
  error?: string;
}

/**
 * 发送群内验证消息，并把 message_id 回写到会话（通过/失败时据此删除提示）。
 * 发送失败（机器人被禁言/无发言权限等）不抛出：调用方按 error 记录并继续。
 */
export async function sendGroupVerificationPrompt(
  api: Api,
  params: GroupPromptParams & { verifyUrl: string | null },
): Promise<GroupPromptDelivery> {
  try {
    const message = await api.sendMessage(
      Number(params.chatId),
      buildGroupPromptHTML(params),
      {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: buildGroupPromptKeyboard({
          token: params.token,
          method: params.method,
          optionCodes: params.optionCodes,
          verifyUrl: params.verifyUrl,
        }),
      },
    );
    await setSessionGroupMessageId(params.token, message.message_id);
    console.log(
      `[group-verify] 群内验证提示已发送: chat=${params.chatId} user=${params.userId} message=${message.message_id} method=${params.method}`,
    );
    return { delivered: true, messageId: message.message_id };
  } catch (error) {
    const detail = describeError(error);
    console.error(
      `[group-verify] 群内验证提示发送失败: chat=${params.chatId} user=${params.userId} method=${params.method}: ${detail}`,
    );
    return { delivered: false, messageId: null, error: detail };
  }
}

/** 尝试次数未用尽时刷新群内提示（显示剩余次数）；失败静默（消息可能已被删除） */
export async function refreshGroupPromptAttempts(params: {
  chatId: bigint;
  userId: bigint;
  messageId: number | null;
  html: string;
  keyboard: InlineKeyboard | undefined;
}): Promise<void> {
  if (!params.messageId) return;
  try {
    const bot = await resolveBotForChat("refreshGroupPrompt", params.chatId, params.userId);
    await bot.api.editMessageText(
      Number(params.chatId),
      params.messageId,
      params.html,
      {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: params.keyboard,
      },
    );
  } catch (error) {
    console.warn(
      `[group-verify] 刷新群内验证提示失败: message=${params.messageId}: ${describeError(error)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 结果收口
// ---------------------------------------------------------------------------

/** 群内 `/verify` 网页地址；未配置 Base URL 时返回 null（bootstrap 据此降级为私聊渠道） */
export async function resolveVerifyUrl(token: string): Promise<string | null> {
  try {
    const runtime = await getRuntimeSettings(config);
    const base = (runtime.baseUrl ?? "").trim().replace(/\/$/, "");
    if (!base) return null;
    return `${base}/verify?token=${encodeURIComponent(token)}`;
  } catch (error) {
    console.warn("[group-verify] 读取系统 Base URL 失败，无法生成验证页面链接:", error);
    return null;
  }
}

export interface GroupCompletionResult {
  success: boolean;
  error?: string;
}

/**
 * 群内渠道验证通过：落库批准 + 解禁 + 删除群内验证消息 + 群内欢迎。
 * 所有 Telegram 动作失败都不回滚数据库批准（用户已在群内且验证已通过，
 * 仅在返回中带上 error 供调用方提示管理员检查机器人权限）。
 */
export async function completeGroupJoinVerification(
  token: string,
): Promise<GroupCompletionResult> {
  const session = await getVerificationSession(token);
  const joinRequest = await getJoinRequestByToken(token);
  if (!session) return { success: false, error: "验证会话不存在" };
  if (!joinRequest) return { success: false, error: "加群申请不存在" };

  const chatId = session.chatId;
  const userId = session.userId;
  const settings = await getGroupSettings(chatId);

  // 1) 数据库批准（不调用 approveChatJoinRequest：群内渠道在 bootstrap 阶段已自动批准入群）
  const approved = await approveJoinRequest(token);
  if (!approved) return { success: false, error: "数据库更新失败" };

  // 2) 解禁 + 删除群内验证提示
  await unmuteGroupMember(chatId, userId);
  await deleteGroupMessage(chatId, userId, session.groupMessageId);

  // 3) 群内欢迎（成功文案沿用群组配置的 success_text）
  const name = memberDisplayName({
    firstName: joinRequest.firstName,
    lastName: joinRequest.lastName,
    username: joinRequest.username,
  });
  const successText = settings?.successText ?? "✅ 验证成功，欢迎加入！";
  await sendGroupNotice(
    chatId,
    userId,
    `${memberMentionHTML(userId, name)} ${htmlEscape(successText)}`,
  );

  console.log(
    `[group-verify] 验证通过: user=${userId} chat=${chatId} request=${joinRequest.requestType}`,
  );
  return { success: true };
}

/**
 * 群内渠道验证失败（尝试用尽 / 超时）：
 * 删除群内提示 → 群内告知 → 踢出（可重新申请）→ 尽力私聊「重新申请」按钮。
 *
 * 与私聊渠道的区别：私聊渠道由 tasks.ts 走 dismissJoinRequest + notifyVerificationExpired，
 * 群内渠道用户已在群内（bootstrap 已自动批准），必须踢出而不是拒绝申请。
 */
export async function failGroupVerification(params: {
  chatId: bigint;
  userId: bigint;
  token: string;
  requestType: string;
  /** 失败原因（写入群内告知，便于其他成员理解发生了什么） */
  reason?: string;
  /** 群内告知文案（默认：❌ 未通过验证，已被移出群组） */
  noticeText?: string;
  /** 是否尽力私聊附「重新申请」按钮（任务清理路径传 true；用户主动输错路径传 false） */
  notifyDm?: boolean;
}): Promise<{ kicked: boolean }> {
  const session = await getVerificationSession(params.token);
  const joinRequest = await getJoinRequestByToken(params.token);
  const messageId = session?.groupMessageId ?? null;

  // 会话失效 + 申请置为 rejected（供管理端「加群申请」列表与超时清理判断）
  // 注意：超时清理路径已在 cleanupExpiredSessions 里把申请置为 expired，
  // 这里只在仍为 pending 时才改成 rejected（不覆盖超时语义）
  await expireVerificationSession(params.token);
  if (joinRequest && joinRequest.status === "pending") {
    await rejectJoinRequest(params.token);
  }

  await deleteGroupMessage(params.chatId, params.userId, messageId);

  const name = memberDisplayName({
    firstName: joinRequest?.firstName,
    lastName: joinRequest?.lastName,
    username: joinRequest?.username,
  });
  const reasonText = params.reason?.trim();
  const notice =
    params.noticeText?.trim() ||
    `❌ ${memberMentionHTML(params.userId, name)} 未在限时内完成验证${
      reasonText ? `（${htmlEscape(reasonText)}）` : ""
    }，已被移出群组。`;

  // 先告知再踢出：踢出后成员看不到本条消息，但其他成员能看到处理结果
  await sendGroupNotice(params.chatId, params.userId, notice);

  let kicked = false;
  try {
    const { kickUnverifiedMember } = await import("./approval");
    kicked = await kickUnverifiedMember(params.chatId, params.userId);
  } catch (error) {
    console.error(`[group-verify] 踢出未验证成员失败: ${describeError(error)}`);
  }

  if (params.notifyDm) {
    // 尽力私聊「重新申请」按钮：用户可能从未 /start 过机器人，失败仅记录
    try {
      const { notifyVerificationExpired } = await import("./approval");
      await notifyVerificationExpired(
        params.chatId,
        params.userId,
        "direct",
        kicked,
      );
    } catch (error) {
      console.warn(
        `[group-verify] 私聊「重新申请」通知失败（用户可能未启动机器人）: ${describeError(error)}`,
      );
    }
  }

  console.log(
    `[group-verify] 验证失败收口: user=${params.userId} chat=${params.chatId} kicked=${kicked} reason=${reasonText ?? "-"}`,
  );
  return { kicked };
}

/** 群组配置是否走群内渠道（默认 group；只有显式 dm 才走私聊） */
export function isGroupChannel(settings: GroupSettingsRow | null): boolean {
  if (!settings) return false;
  return settings.verifyChannel !== "dm";
}

/**
 * 会话渠道判定：会话快照优先（创建时固化），缺失时回落到群组当前配置。
 * 用于 verification-flow / 三端（网页、callback、私聊文本）的结果分流。
 */
export function resolveSessionChannel(
  session: VerificationSessionRow,
  settings: GroupSettingsRow | null,
): "group" | "dm" {
  if (session.channel === "group") return "group";
  if (session.channel === "dm") return "dm";
  return isGroupChannel(settings) ? "group" : "dm";
}

/** 会话对应的群内提示消息 id（缺失时从会话行补读，供无 session 对象的调用方使用） */
export async function loadGroupMessageId(token: string): Promise<number | null> {
  const session = await getVerificationSession(token);
  return session?.groupMessageId ?? null;
}

/** 群内提示的「失败重试」版本正文（保留原提示 + 错误原因 + 剩余次数） */
export function buildGroupRetryHTML(params: {
  baseHtml: string;
  failureText: string;
  reason: string;
  remaining: number;
}): string {
  return [
    params.baseHtml,
    "",
    `❌ ${htmlEscape(params.failureText)}`,
    `错误原因：${htmlEscape(params.reason)}`,
    `剩余尝试次数：${params.remaining}`,
  ].join("\n");
}

/** 供 JoinRequestRow 类型对齐（避免调用方重复导入） */
export type { JoinRequestRow };
