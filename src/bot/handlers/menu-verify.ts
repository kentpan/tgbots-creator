import { StatelessQuestion } from "@grammyjs/stateless-question";
import type { BotContext } from "../context";
import { getVerificationMethod } from "@/database/operations";
import {
  parseCodeApiConfig,
  verifyCodeExternally,
} from "@/services/external-verify";
import type { MenuVerifyConfig } from "@/services/menu-config";
import { htmlEscape } from "@/utils/html";

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
 */

/** 菜单验证无状态问题 id（每个机器人实例独立安装，互不串扰） */
const MENU_VERIFY_QUESTION_ID = "tgmenuverify";

/** 输错验证码的最大尝试次数（与群组验证默认最大尝试次数一致） */
const MENU_VERIFY_MAX_ATTEMPTS = 3;

/** 输入提示默认文案（v2.1.14：点击按钮后先发送，引导去输入框输入；配置留空时使用） */
const DEFAULT_INPUT_HINT_TEXT = "✍🏻 请在下方的输入框进行输入:";

/** 其余默认文案（按钮配置留空时使用；与图2 外部API 验证文案同款语义） */
const DEFAULT_PROMPT_TEXT = "🔐 请回复本消息并输入验证码完成验证";
const DEFAULT_SUCCESS_TEXT = "✅ 验证成功！";
const DEFAULT_FAIL_TEXT = "❌ 验证失败";

/** 菜单验证会话状态（挂 session；点击按钮时写入，核验出结果后清除） */
export interface MenuVerifySessionState {
  methodId: string;
  successText: string;
  failText: string;
  attempts: number;
}

/**
 * 菜单「外部验证 API」按钮点击入口：校验绑定方法 → 写入会话状态 →
 * force-reply 发送提示文案要求在输入框回复验证码。
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
  ctx.session.menuVerify = {
    methodId,
    successText: verify.success_text?.trim() ?? "",
    failText: verify.fail_text?.trim() ?? "",
    attempts: 0,
  };
  // v2.1.14：需要用户在输入框输入的交互，点击后默认先发一条输入提示
  //（文案可在按钮配置中自定义；配置留空回落默认，永不发送空消息）
  const inputHint = verify.input_hint_text?.trim() || DEFAULT_INPUT_HINT_TEXT;
  await ctx.reply(inputHint);
  const prompt = verify.prompt_text?.trim() || DEFAULT_PROMPT_TEXT;
  await menuVerifyQuestion.replyWithHTML(ctx, htmlEscape(prompt));
  console.log(
    `Menu verify flow started: user ${from.id} method ${method.id} (${method.name}) chat ${ctx.chat?.id ?? "?"}`,
  );
}

/**
 * 验证码回复处理（StatelessQuestion handler）：读取会话状态真实核验，
 * 按自定义文案播报结果；失败可继续回复重试（网络故障不计次）。
 */
async function handleMenuVerifyAnswer(ctx: BotContext, code: string): Promise<void> {
  const from = ctx.from;
  const state = ctx.session.menuVerify;
  if (!from || from.is_bot) return;
  if (!state) {
    // 回复的是历史验证提示消息，但会话状态已丢失（重启/已结束）→ 明确引导重新发起
    await ctx.reply("⚠️ 验证会话已过期，请重新点击菜单中的验证按钮发起验证。");
    return;
  }
  const method = /^\d+$/.test(state.methodId)
    ? await getVerificationMethod(BigInt(state.methodId))
    : null;
  if (!method || !method.enabled) {
    ctx.session.menuVerify = undefined;
    await ctx.reply("⚠️ 绑定的验证方法已失效，请重新点击菜单按钮发起验证或联系管理员。");
    return;
  }
  const apiConfig = parseCodeApiConfig(method.config);
  if (!apiConfig) {
    ctx.session.menuVerify = undefined;
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
    ctx.session.menuVerify = undefined;
    await ctx.reply(state.successText || DEFAULT_SUCCESS_TEXT);
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
  const attempts = state.attempts + 1;
  if (attempts >= MENU_VERIFY_MAX_ATTEMPTS) {
    ctx.session.menuVerify = undefined;
    await ctx.reply(
      `${state.failText || `❌ ${result.message}`}\n\n验证尝试次数已达上限（${MENU_VERIFY_MAX_ATTEMPTS} 次），请重新点击菜单中的验证按钮发起验证。`,
    );
    console.log(
      `Menu verify exhausted: user ${from.id} method ${method.id} attempts=${attempts}`,
    );
    return;
  }
  ctx.session.menuVerify = { ...state, attempts };
  await ctx.reply(
    `${state.failText || `❌ ${result.message}`}\n\n请回复上方验证提示消息重新输入验证码（剩余 ${MENU_VERIFY_MAX_ATTEMPTS - attempts} 次）。`,
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
