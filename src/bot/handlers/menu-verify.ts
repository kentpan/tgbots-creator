import { StatelessQuestion } from "@grammyjs/stateless-question";
import type { BotContext } from "../context";
import { getVerificationMethod } from "@/database/operations";
import {
  parseCodeApiConfig,
  verifyCodeExternally,
} from "@/services/external-verify";
import type { MenuVerifyConfig } from "@/services/menu-config";
import { DEFAULT_GROUP_PROMPT_TEXT } from "@/services/bot-messages";
import { htmlEscape, userMentionHTML } from "@/utils/html";

/**
 * 菜单「外部验证 API」按钮（v2.1.12）：与群组外部 API 验证同一机制 ——
 * 按钮绑定「验证方式」库中的验证方法（code_api），点击后 force-reply 要求
 * 在输入框回复验证码，verifyCodeExternally 真实核验，按自定义文案播报结果。
 *
 * 与群组验证 codeQuestion（tgcode）并列的独立 StatelessQuestion（tgmenuverify）：
 * 两个问题的回复按消息内嵌的 question id 精确路由，互不串扰；验证方法配置
 * （地址 / Bearer apikey / 传参 / 响应解析 / 超时）全部复用验证方式库，本模块
 * 只携带 method_id 与可自定义的提示/成功/失败文案。
 *
 * 尝试次数：输错验证码计入尝试（默认上限 3 次，与群组验证最大尝试次数一致），
 * 网络故障不计入（与群组验证同口径）；达到上限后要求重新点击按钮发起。
 *
 * v3.0.4 验证交互方式开关（与自定义键盘/加群验证提示按钮共用同一交互模型）：
 * - 使用私聊回复（verify.private_reply）：群内点击按钮 → 机器人把验证提示发到
 *   点击者私聊，用户在私聊对话中回复验证码（群友不可见）。私聊流程的会话状态
 *   存进程内存 Map（会话存储按 chat.id 键控，跨聊天写不进去；重启丢失 =
 *   用户重新点击按钮即可，无副作用）。
 * - 锁定用户回复（verify.lock_user）：群内 force-reply 流程的会话状态按 chat
 *   键控（全群共享）—— 状态中记录发起者 id，其他成员回复不消耗次数、不产生结果。
 */

/** 菜单验证无状态问题 id（每个机器人实例独立安装，互不串扰） */
const MENU_VERIFY_QUESTION_ID = "tgmenuverify";

/** 输错验证码的最大尝试次数（与群组验证默认最大尝试次数一致） */
const MENU_VERIFY_MAX_ATTEMPTS = 3;

/** 输入提示默认文案（v2.1.14：点击按钮后先发送，引导去输入框输入；配置留空时使用） */
const DEFAULT_INPUT_HINT_TEXT = "✍🏻 请在下方的输入框进行输入:";

/** 其余默认文案（按钮配置留空时使用；与图2 外部API 验证文案同款语义） */
const DEFAULT_PROMPT_TEXT = DEFAULT_GROUP_PROMPT_TEXT;
const DEFAULT_SUCCESS_TEXT = "✅ 验证成功！";
const DEFAULT_FAIL_TEXT = "❌ 验证失败";

/** 菜单验证会话状态（挂 session；点击按钮时写入，核验出结果后清除） */
export interface MenuVerifySessionState {
  methodId: string;
  successText: string;
  failText: string;
  attempts: number;
  /** v3.0.4 锁定用户回复：发起者 user id（lock_user 开启时校验回复者身份） */
  initiatorId?: number;
  /** v3.0.4 锁定用户回复开关（会话状态随按钮配置透传） */
  lockUser?: boolean;
}

/**
 * v3.0.4 私聊回复模式的会话状态（进程内存，键 = `${botUsername}:${userId}`）：
 * 会话存储按 chat.id 键控（群聊会话与私聊会话是两条数据），点击发生在群、
 * 回复发生在私聊 —— 状态无法经 ctx.session 跨聊天携带，改存内存。
 * 重启丢失 = 私聊回复收到「会话已过期」，重新点击按钮即可，无副作用。
 */
interface PrivateMenuVerifyState {
  methodId: string;
  successText: string;
  failText: string;
  attempts: number;
  expiresAt: number;
}
const PRIVATE_MENU_VERIFY_TTL_MS = 10 * 60 * 1000;
const privateMenuVerifyMap = new Map<string, PrivateMenuVerifyState>();

function privateVerifyKey(botKey: string, userId: number): string {
  return `${botKey}:${userId}`;
}

function privateVerifyKeyFor(ctx: BotContext, userId: number): string | null {
  const botKey = ctx.me?.username ?? null;
  return botKey ? privateVerifyKey(botKey, userId) : null;
}

/**
 * 菜单「外部验证 API」按钮点击入口：校验绑定方法 → 写入会话状态 →
 * force-reply 发送提示文案要求在输入框回复验证码。
 * v3.0.4：verify.private_reply 开启且点击发生在群内时，验证提示改发点击者私聊。
 */
export async function startMenuVerifyFlow(ctx: BotContext, verify: MenuVerifyConfig): Promise<void> {
  const from = ctx.from;
  if (!from || from.is_bot) return;
  const methodId = verify.method_id.trim();
  const method = /^\d+$/.test(methodId)
    ? await getVerificationMethod(BigInt(methodId))
    : null;
  if (!method || !method.enabled) {
    await ctx.reply("⚠️ 该按钮绑定的验证方法不存在或已停用，请联系管理员检查「验证方式」配置。");
    return;
  }
  const apiConfig = parseCodeApiConfig(method.config);
  if (!apiConfig) {
    console.error(
      `Menu verify button: method ${method.id} (${method.name}) has invalid code API config`,
    );
    await ctx.reply("⚠️ 该按钮绑定的验证方法配置异常，请联系管理员检查「验证方式」配置。");
    return;
  }

  const inputHint = verify.input_hint_text?.trim() || DEFAULT_INPUT_HINT_TEXT;
  const prompt = verify.prompt_text?.trim() || DEFAULT_PROMPT_TEXT;
  const inGroup = Boolean(ctx.chat && ctx.chat.type !== "private");

  // v3.0.4 使用私聊回复：群内点击 → 私聊发送验证提示，用户在私聊回复验证码
  if (inGroup && verify.private_reply === true) {
    const key = privateVerifyKeyFor(ctx, from.id);
    if (!key) {
      await ctx.reply("⚠️ 验证会话初始化失败，请稍后重试。");
      return;
    }
    privateMenuVerifyMap.set(key, {
      methodId,
      successText: verify.success_text?.trim() ?? "",
      failText: verify.fail_text?.trim() ?? "",
      attempts: 0,
      expiresAt: Date.now() + PRIVATE_MENU_VERIFY_TTL_MS,
    });
    const dmText =
      `${htmlEscape(inputHint)}\n\n${htmlEscape(prompt)}\n\n` +
      "🔒 私聊对话中回复验证码，群内其他成员不可见。" +
      menuVerifyQuestion.messageSuffixHTML();
    try {
      await ctx.api.sendMessage(from.id, dmText, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: { force_reply: true, input_field_placeholder: "输入验证码" },
      });
    } catch (error) {
      privateMenuVerifyMap.delete(key);
      console.warn(
        `Menu verify private prompt failed: user ${from.id} — ${error instanceof Error ? error.message : error}`,
      );
      await ctx.reply(
        "⚠️ 无法向你发送私聊消息：请先私聊本机器人发送任意一句话（如 /start），再回来点击按钮。",
      );
      return;
    }
    await ctx.reply(
      `${userMentionHTML({ id: from.id, username: from.username, first_name: from.first_name, last_name: from.last_name })} 已发送验证提示到你的私聊，请在私聊中回复验证码完成验证。`,
      { parse_mode: "HTML" },
    );
    console.log(
      `Menu verify flow started (private reply): user ${from.id} method ${method.id} (${method.name}) group ${ctx.chat?.id ?? "?"}`,
    );
    return;
  }

  // 群内 force-reply 流程：会话状态按 chat 键控（全群共享），lock_user 开启时
  // 记录发起者，其他成员回复在核验前即被拒绝（不消耗次数）
  ctx.session.menuVerify = {
    methodId,
    successText: verify.success_text?.trim() ?? "",
    failText: verify.fail_text?.trim() ?? "",
    attempts: 0,
    ...(inGroup && verify.lock_user === true
      ? { initiatorId: from.id, lockUser: true }
      : {}),
  };
  // v2.1.14：需要用户在输入框输入的交互，点击后默认先发一条输入提示
  //（文案可在按钮配置中自定义；配置留空回落默认，永不发送空消息）
  await ctx.reply(inputHint);
  await menuVerifyQuestion.replyWithHTML(ctx, htmlEscape(prompt));
  console.log(
    `Menu verify flow started: user ${from.id} method ${method.id} (${method.name}) chat ${ctx.chat?.id ?? "?"}` +
      `${inGroup && verify.lock_user === true ? " (locked to initiator)" : ""}`,
  );
}

/**
 * 验证码回复处理（StatelessQuestion handler）：读取会话状态真实核验，
 * 按自定义文案播报结果；失败可继续回复重试（网络故障不计次）。
 * v3.0.4：私聊回复模式的状态在内存 Map（私聊会话无 group 状态）；lock_user
 * 校验回复者必须是发起者。
 */
async function handleMenuVerifyAnswer(ctx: BotContext, code: string): Promise<void> {
  const from = ctx.from;
  const state = ctx.session.menuVerify;
  if (!from || from.is_bot) return;

  // v3.0.4 锁定用户回复：仅发起者本人的回复有效（其他成员回复不消耗次数）
  if (state?.lockUser && state.initiatorId !== undefined && from.id !== state.initiatorId) {
    await ctx.reply("🔒 该验证由其他用户发起，只有发起者回复验证码才有效。");
    return;
  }

  // v3.0.4 私聊回复模式：群会话无状态 → 查内存 Map（键 = bot + user）
  let privateState: PrivateMenuVerifyState | null = null;
  let privateKey: string | null = null;
  if (!state) {
    privateKey = privateVerifyKeyFor(ctx, from.id);
    const cached = privateKey ? privateMenuVerifyMap.get(privateKey) : undefined;
    if (cached && cached.expiresAt > Date.now()) {
      privateState = cached;
    } else if (cached) {
      privateMenuVerifyMap.delete(privateKey!);
    }
  }
  const activeState:
    | {
        methodId: string;
        successText: string;
        failText: string;
        attempts: number;
        initiatorId?: number;
        lockUser?: boolean;
      }
    | undefined = privateState
    ? {
        methodId: privateState.methodId,
        successText: privateState.successText,
        failText: privateState.failText,
        attempts: privateState.attempts,
      }
    : state;
  if (!activeState) {
    // 回复的是历史验证提示消息，但会话状态已丢失（重启/已结束）→ 明确引导重新发起
    await ctx.reply("⚠️ 验证会话已过期，请重新点击菜单中的验证按钮发起验证。");
    return;
  }
  const persistAttempts = (attempts: number): void => {
    if (privateState && privateKey) {
      privateMenuVerifyMap.set(privateKey, {
        ...privateState,
        attempts,
        expiresAt: Date.now() + PRIVATE_MENU_VERIFY_TTL_MS,
      });
    } else {
      ctx.session.menuVerify = { ...activeState, attempts };
    }
  };
  const clearState = (): void => {
    if (privateKey) privateMenuVerifyMap.delete(privateKey);
    else ctx.session.menuVerify = undefined;
  };

  const method = /^\d+$/.test(activeState.methodId)
    ? await getVerificationMethod(BigInt(activeState.methodId))
    : null;
  if (!method || !method.enabled) {
    clearState();
    await ctx.reply("⚠️ 绑定的验证方法已失效，请重新点击菜单按钮发起验证或联系管理员。");
    return;
  }
  const apiConfig = parseCodeApiConfig(method.config);
  if (!apiConfig) {
    clearState();
    await ctx.reply("⚠️ 绑定的验证方法配置异常，请联系管理员检查「验证方式」配置。");
    return;
  }
  const result = await verifyCodeExternally(
    apiConfig,
    { userId: BigInt(from.id), username: from.username ?? null, code },
    {
      onNetworkRetry: async () => {
        await ctx.reply("🌐 网络波动，正在重试...");
      },
    },
  );
  if (result.ok) {
    clearState();
    await ctx.reply(activeState.successText || DEFAULT_SUCCESS_TEXT);
    console.log(
      `Menu verify passed: user ${from.id} method ${method.id} (${method.name}) chat ${ctx.chat?.id ?? "?"}`,
    );
    return;
  }
  if (result.networkError) {
    // 与群组验证同口径：网络故障不计入尝试次数，会话保留，回复原提示消息即可重试
    await ctx.reply(
      `${result.message}${result.detail ? `\n原因：${result.detail}` : ""}\n请回复上方验证提示消息重新输入验证码。`,
    );
    return;
  }
  const attempts = activeState.attempts + 1;
  if (attempts >= MENU_VERIFY_MAX_ATTEMPTS) {
    clearState();
    await ctx.reply(
      `${activeState.failText || `❌ ${result.message}`}\n\n验证尝试次数已达上限（${MENU_VERIFY_MAX_ATTEMPTS} 次），请重新点击菜单中的验证按钮发起验证。`,
    );
    console.log(
      `Menu verify exhausted: user ${from.id} method ${method.id} attempts=${attempts}`,
    );
    return;
  }
  persistAttempts(attempts);
  await ctx.reply(
    `${activeState.failText || `❌ ${result.message}`}\n\n请回复上方验证提示消息重新输入验证码（剩余 ${MENU_VERIFY_MAX_ATTEMPTS - attempts} 次）。`,
  );
}

/** 菜单验证无状态问题（每个机器人实例安装 middleware，见 multi-runtime createMenuBot） */
export const menuVerifyQuestion = new StatelessQuestion<BotContext>(
  MENU_VERIFY_QUESTION_ID,
  async (ctx) => {
    const code = ctx.message?.text?.trim() ?? "";
    if (!code) return;
    await handleMenuVerifyAnswer(ctx, code);
  },
);
