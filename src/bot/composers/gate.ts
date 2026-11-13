import { StatelessQuestion } from "@grammyjs/stateless-question";
import { Composer } from "grammy";
import type { BotContext } from "../context";
import { getTgApiUnlock, getVerificationMethod } from "@/database/operations";
import { parseCodeApiConfig, verifyCodeExternally } from "@/services/external-verify";
import { parseBotFeatureConfig, type BotFeatureConfig } from "@/services/bot-feature-config";
import { parseVerificationParams, VERIFICATION_TEXT_DEFAULTS } from "@/services/verification-methods";
import { persistTgApiUnlock } from "../tgapi-gate";
import { htmlEscape } from "@/utils/html";

/**
 * 通用门禁解锁 Composer（会话级解锁，全局共享解锁状态 tgapi_unlocks）：
 *
 * 与加群验证完全独立 —— 门禁挂在「内嵌按钮 / 自定义键盘按钮 / 指令」上做前置校验：
 * 未解锁用户点击挂门禁的入口 → 机器人私聊发送解锁挑战（绑定验证方式的验证码）；
 * 通过后落库 tgapi_unlocks（bot+user 维度），之后该机器人的所有门禁入口全部放行。
 *
 * 门禁方式（v2.3 星星解锁已移除）：固定验证码解锁 —— 绑定验证方式库中的
 * code_api 方式（外部 API 核验，StatelessQuestion force-reply）。
 */

/** 门禁解锁挑战的 stateless-question（独立于加群验证的 tgcode，互不串扰） */
const gateQuestion = new StatelessQuestion<BotContext>(
  "tggate",
  async (ctx) => {
    // botId 在挑战发送时写入 session（gateBotId）；回复时据此定位解锁台账
    const challenge = ctx.session.gateChallenge;
    const currentBotId = ctx.session.gateBotId;
    if (!challenge || !currentBotId) {
      await ctx.reply("未找到进行中的验证，请重新点击入口按钮。");
      return;
    }
    await handleGateAnswer(ctx, BigInt(currentBotId), challenge, ctx.message?.text ?? "");
  },
);

/** 解析门禁方式（绑定验证方式库 code_api 行），null = 配置不完整 */
async function resolveGateMethod(
  botId: bigint,
  feature: BotFeatureConfig,
): Promise<{ promptText?: string } | null> {
  const methodId = feature.gate.verificationMethodId;
  if (!methodId) {
    console.error(`[gate] bot #${botId} gate enabled without bound method — refusing`);
    return null;
  }
  const method = await getVerificationMethod(BigInt(methodId));
  if (!method || !method.enabled) {
    console.error(`[gate] bot #${botId} gate method ${methodId} missing or disabled`);
    return null;
  }
  const apiConfig = parseCodeApiConfig(method.config);
  if (!apiConfig) {
    console.error(`[gate] bot #${botId} gate method ${method.id} invalid code API config`);
    return null;
  }
  const params = parseVerificationParams(method.config);
  return { promptText: params.prompt_text };
}

/** 用户是否已解锁该机器人的门禁（全局共享解锁状态，解锁一次永久有效） */
export async function isGateUnlocked(botId: bigint, userId: bigint): Promise<boolean> {
  const unlock = await getTgApiUnlock(botId, userId);
  return Boolean(unlock);
}

/**
 * 门禁前置校验：已解锁返回 true；未解锁发送挑战并返回 false。
 * bot 未配置门禁（面板关/无方式）→ 直接放行（门禁是可选附加，不配置即无门禁）。
 */
export async function ensureGateUnlocked(
  botId: bigint,
  feature: BotFeatureConfig,
  ctx: BotContext,
): Promise<boolean> {
  if (!ctx.from || ctx.from.is_bot) return true;
  if (!feature.gate.enabled) return true;
  const botIdSafe = botId;
  if (await isGateUnlocked(botIdSafe, BigInt(ctx.from.id))) return true;

  const resolved = await resolveGateMethod(botIdSafe, feature);
  if (!resolved) {
    // 门禁开启但绑定方式不可用：绝不放行（门禁语义 = 不通过不执行），显式报错
    console.error(`[gate] bot #${botIdSafe} gate enabled but no usable method — refusing entry`);
    await ctx.reply("⚠️ 门禁验证方式不可用，请联系管理员在「验证方式」页检查配置。");
    return false;
  }

  const userId = ctx.from.id;
  const promptText = resolved.promptText ?? VERIFICATION_TEXT_DEFAULTS.prompt_text;

  // 私聊 force-reply 挑战（真实外部 API 核验）
  try {
    ctx.session.gateChallenge = {
      methodId: feature.gate.verificationMethodId ?? "",
    };
    ctx.session.gateBotId = String(botIdSafe);
    await ctx.api.sendMessage(
      userId,
      htmlEscape(promptText) + gateQuestion.messageSuffixHTML(),
      {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: {
          force_reply: true,
          input_field_placeholder: "输入验证码",
        },
      },
    );
    await ctx.api.sendMessage(userId, "🔐 验证通过后，请返回并重新点击刚才的按钮。");
    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("chat not found")) {
      await ctx.reply("⚠️ 请先私聊我（点击我的头像 → 开始）再点击此按钮完成解锁。");
      return false;
    }
    console.error(`[gate] failed to send challenge to user ${userId}:`, error);
    await ctx.reply("⚠️ 发送验证消息失败，请稍后重试。");
    return false;
  }
}

/** 门禁答案处理（外部 API 核验）：通过即落库解锁 */
async function handleGateAnswer(
  ctx: BotContext,
  botId: bigint,
  challenge: { methodId: string },
  codeText: string,
): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  const code = codeText.trim();
  if (!code) {
    await ctx.reply("请输入验证码。");
    return;
  }

  const method = await getVerificationMethod(BigInt(challenge.methodId));
  if (!method || !method.enabled) {
    await ctx.reply("⚠️ 验证方式不可用，请联系管理员。");
    return;
  }
  const apiConfig = parseCodeApiConfig(method.config);
  if (!apiConfig) {
    console.error(`[gate] bot #${botId} method ${method.id} invalid config at answer time`);
    await ctx.reply("⚠️ 验证配置异常，请联系管理员。");
    return;
  }
  const result = await verifyCodeExternally(apiConfig, {
    userId: BigInt(userId),
    username: ctx.from?.username ?? null,
    code,
  });
  if (!result.ok) {
    await ctx.reply(
      result.networkError
        ? "🌐 网络异常，本次未消耗机会，请重新发送验证码。"
        : `❌ ${result.message}`,
    );
    return;
  }

  // 通过：落库解锁 + 回读校验（回读失败绝不发送成功语义）
  const ok = await persistTgApiUnlock(
    { botId },
    BigInt(userId),
    ctx.from?.username ?? null,
    "captcha",
  );
  if (!ok) {
    await ctx.reply("⚠️ 解锁状态保存失败，请重试。");
    return;
  }
  ctx.session.gateChallenge = undefined;
  await ctx.reply("✅ 解锁成功！请返回并重新点击刚才的按钮。");
  console.log(`[gate] bot #${botId} user ${userId} unlocked (method=${method.type})`);
}

/**
 * 门禁 Composer（每实例注册）：承接门禁挑战回复。
 * botId 从实例闭包注入挑战会话（session.gateBotId）。
 */
export function createGateComposer(_botId: bigint): Composer<BotContext> {
  const composer = new Composer<BotContext>();
  composer.use(gateQuestion.middleware());
  return composer;
}

/** 门禁配置读取捷径（菜单按钮 withGate 使用：从 bot 行解析 feature 配置） */
export async function loadBotFeatureForGate(botId: bigint): Promise<BotFeatureConfig | null> {
  const { getBot } = await import("@/database/operations");
  const bot = await getBot(botId);
  if (!bot) return null;
  return parseBotFeatureConfig(bot.config, false);
}
