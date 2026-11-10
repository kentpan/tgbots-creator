import { Router } from "@grammyjs/router";
import type { Api } from "grammy";
import type { BotContext } from "./context";
import { getTgApiUnlock, getVerificationMethod, saveTgApiUnlock } from "@/database/operations";
import {
  parseCodeApiConfig,
  verifyCodeExternally,
  type ExternalVerifyHooks,
  type ExternalVerifyResult,
} from "@/services/external-verify";
import type { CodeApiConfig } from "@/services/external-verify";
import { TGAPI_SYSTEM_TEXTS, type TgApiBotConfig, type TgApiLang } from "@/services/tgapi-config";

/**
 * TGAPI 门禁通用组件（v2.2.2）——grammy Router 中间件形态 + 共享核验核心。
 *
 * 参考https://grammy.dev/zh/plugins/router：门禁是一个「locked / open」双路由层，
 * 未解锁用户的消息统一进 locked 路由（门禁全部行为），已解锁用户进 open 路由
 * （宿主业务），指令与支付/回调类更新透传下游（路由函数返回 undefined）。
 *
 * 内嵌按钮模式（handlers/tgapi.ts）：createTgApiGateRouter 直接挂 bot.use；
 * 自定义键盘对话模式（handlers/tgapi-conversation.ts）：@grammyjs/conversations
 * 的 wait 循环无法由外部中间件驱动，因此复用本组件的同一套核验核心
 *（checkTgApiGateMethod / verifyTgApiUnlockCode / persistTgApiUnlock /
 *  sendTgApiStarsInvoice）实现门禁步——两种交互流程共用同一门禁实现。
 *
 * 门禁红线（v2.2.2 硬化）：
 * - 验证码必须真实调用外部验证 API（verifyCodeExternally），任何配置缺失、
 *   网络/核验失败路径都绝不写解锁台账；
 * - 解锁落库后回读校验（persistTgApiUnlock），回读失败视为未解锁；
 * - 星星金额未配置（<1）绝不自动放行（旧实现的真实漏洞，已封死）。
 */

export interface TgApiGateDeps {
  cfg: TgApiBotConfig;
  botId: bigint;
}

/** 门禁配置完整性（同步）：captcha 必须绑定验证方式，stars 必须金额≥1 */
export function isTgApiGateConfigured(cfg: TgApiBotConfig): boolean {
  if (cfg.unlockMode === "captcha") return Boolean(cfg.verificationMethodId);
  return (cfg.starsAmount ?? 0) >= 1;
}

/** 门禁核验前置检查结果（captcha 模式） */
export type TgApiGateMethodCheck =
  | { kind: "ready"; apiConfig: CodeApiConfig; methodId: number }
  | { kind: "method-missing" }
  | { kind: "method-unavailable" }
  | { kind: "method-config-invalid" };

/**
 * 读取绑定的验证方式并解析外部核验配置（真实核验前置步骤，两种模式共用）。
 * 每次核验都实时读库 —— 管理端改绑定/停用验证方式立即生效，不缓存。
 */
export async function checkTgApiGateMethod(deps: TgApiGateDeps): Promise<TgApiGateMethodCheck> {
  const { cfg, botId } = deps;
  if (cfg.unlockMode !== "captcha" || !cfg.verificationMethodId) {
    return { kind: "method-missing" };
  }
  const method = await getVerificationMethod(BigInt(cfg.verificationMethodId));
  if (!method || !method.enabled) {
    return { kind: "method-unavailable" };
  }
  const apiConfig = parseCodeApiConfig(method.config);
  if (!apiConfig) {
    console.error(
      `TGAPI gate #${botId} method ${method.id} has invalid code API config`,
    );
    return { kind: "method-config-invalid" };
  }
  return { kind: "ready", apiConfig, methodId: Number(method.id) };
}

/**
 * 真实外部 API 核验（唯一实现）：verifyCodeExternally 直连验证接口，
 * 5xx/网络故障不重试计费语义由外部验证服务保证；结果逐笔留痕日志。
 */
export async function verifyTgApiUnlockCode(
  deps: TgApiGateDeps,
  apiConfig: CodeApiConfig,
  input: { userId: bigint; username: string | null; code: string },
  hooks?: ExternalVerifyHooks,
): Promise<ExternalVerifyResult> {
  const startedAt = Date.now();
  const result = await verifyCodeExternally(
    apiConfig,
    input,
    hooks ?? {},
  );
  console.log(
    `TGAPI gate #${deps.botId} external verify: user ${input.userId} ` +
      `code_length=${input.code.length} ok=${result.ok} networkError=${result.networkError} ` +
      `cost_ms=${Date.now() - startedAt} reason=${result.message}${result.detail ? ` detail=${result.detail}` : ""}`,
  );
  return result;
}

/**
 * 解锁落库 + 回读校验（写入成功才算解锁）：回读不到记录返回 false，
 * 调用方绝不发送解锁成功提示 —— 杜绝「提示成功但台账无记录」的假门禁。
 */
export async function persistTgApiUnlock(
  deps: TgApiGateDeps,
  userId: bigint,
  username: string | null,
  mode: "captcha" | "stars",
): Promise<boolean> {
  await saveTgApiUnlock({ botId: deps.botId, userId, username, mode });
  const saved = await getTgApiUnlock(deps.botId, userId);
  const ok = Boolean(saved);
  console.log(
    `TGAPI gate #${deps.botId} unlock persisted: user ${userId} mode=${mode} verified=${ok}`,
  );
  return ok;
}

/**
 * 发送星星解锁发票（两种模式共用）。返回 null = 已发送；
 * 返回 "not-configured" = 金额未配置（调用方绝不放行，也不解锁）。
 */
export async function sendTgApiStarsInvoice(
  deps: TgApiGateDeps,
  api: Api,
  chatId: number,
): Promise<string | null> {
  const amount = deps.cfg.starsAmount ?? 0;
  if (amount < 1) {
    console.warn(
      `TGAPI gate #${deps.botId} stars amount not configured; unlock refused`,
    );
    return "not-configured";
  }
  await api.sendInvoice(
    chatId,
    (deps.cfg.starsTitle?.trim() || "TGAPI 解锁").slice(0, 32),
    "首次使用 TGAPI 申请机器人前的一次性解锁".slice(0, 255),
    `tgapi_unlock:${deps.botId}`,
    // Telegram Stars：currency 固定 XTR，provider_token 必须为空字符串
    "XTR",
    [{ label: "TGAPI 解锁", amount }],
    { provider_token: "" },
  );
  console.log(
    `TGAPI gate #${deps.botId} stars invoice sent: chat ${chatId} amount=${amount} XTR`,
  );
  return null;
}

export interface TgApiGateRouterOptions {
  deps: TgApiGateDeps;
  /** 会话语言（宿主提供，与业务同一实现） */
  langOf: (ctx: BotContext) => TgApiLang;
  /**
   * 验证码门禁提示（唯一门禁消息；宿主提供发送方式 —— 内嵌模式用
   * StatelessQuestion force-reply，提问回复由宿主 question 处理器核验）。
   */
  sendCaptchaPrompt: (ctx: BotContext, lang: TgApiLang) => Promise<void>;
  /** 验证码核验受理（宽松通道：任意文本尝试核验；宿主实现调用共享核验核心） */
  onCaptchaAttempt: (ctx: BotContext, lang: TgApiLang, code: string) => Promise<void>;
  /** open 路由宿主处理（已解锁用户的消息） */
  onOpen: (ctx: BotContext, messageText: string | null, contactPhone: string | null) => Promise<void>;
}

/**
 * 通用门禁 Router（grammy @grammyjs/router 中间件组件）：
 * - 路由函数：私聊文本消息按解锁状态分 locked/open；指令、非私聊、
 *   支付（successful_payment）/回调等更新返回 undefined 透传下游；
 * - locked 路由：captcha = 文本进核验（宽松通道）/ 非文本发门禁提示；
 *   stars = 发票或等待支付提示（支付回调整链路由宿主注册，见上）；
 * - open 路由：宿主业务（onOpen）。
 */
export function createTgApiGateRouter(options: TgApiGateRouterOptions): Router<BotContext> {
  const { deps } = options;
  const router = new Router<BotContext>(async (ctx) => {
    if (ctx.chat?.type !== "private" || !ctx.from || ctx.from.is_bot || !ctx.message) {
      return undefined;
    }
    // 支付消息始终透传（支付成功落库由宿主 successful_payment 处理器完成）
    if (ctx.message.successful_payment) return undefined;
    // 指令透传（指令菜单勾选注册的指令有自己的处理器；/start 门禁语义由宿主决定）
    if ((ctx.msg?.text ?? "").startsWith("/")) return undefined;
    const unlocked = await getTgApiUnlock(deps.botId, BigInt(ctx.from.id));
    return unlocked ? "open" : "locked";
  });

  router.route("locked", async (ctx) => {
    const lang = options.langOf(ctx);
    const sys = TGAPI_SYSTEM_TEXTS[lang];
    if (deps.cfg.unlockMode === "stars") {
      const amount = deps.cfg.starsAmount ?? 0;
      if (amount < 1) {
        // 配置缺失：绝不放行也绝不解锁（旧实现此处会自动解锁，属真实漏洞）
        await ctx.reply(sys.starsNotConfigured);
        return;
      }
      if (ctx.session.tgapiStarsInvoiceSent) {
        await ctx.reply(sys.starsInvoicePending);
        return;
      }
      if (!ctx.chat) return;
      const sent = await sendTgApiStarsInvoice(deps, ctx.api, ctx.chat.id);
      if (sent === "not-configured") {
        await ctx.reply(sys.starsNotConfigured);
        return;
      }
      ctx.session.tgapiStarsInvoiceSent = true;
      await ctx.reply(sys.starsInvoiceHint(String(amount)));
      return;
    }
    // captcha：文本 → 宽松通道核验；非文本 → 唯一门禁提示（force-reply，不再叠加输入提示）
    const text = ctx.message?.text?.trim() ?? "";
    if (text) {
      await options.onCaptchaAttempt(ctx, lang, text);
      return;
    }
    await options.sendCaptchaPrompt(ctx, lang);
  });

  router.route("open", async (ctx) => {
    await options.onOpen(
      ctx,
      ctx.message?.text ?? null,
      ctx.message?.contact?.phone_number ?? null,
    );
  });

  return router;
}
