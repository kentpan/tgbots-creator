import { type Bot, type MiddlewareFn } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import {
  conversations,
  createConversation,
  type Conversation,
  type ConversationFlavor,
} from "@grammyjs/conversations";
import type { BotContext } from "../context";
import { getTgApiBotUser, getTgApiUnlock, saveTgApiBotUser } from "@/database/operations";
import {
  countCustomKeyboardStats,
  platformKeyboard,
  renderCustomKeyboardMarkup,
  requestContactKeyboard,
  type CustomKeyboardButton,
  type CustomKeyboardConfig,
} from "@/services/custom-keyboard";
import { TGAPI_APP_PLATFORMS } from "@/services/tgapi-config";
import {
  isValidTgApiPlatformValue,
  renderMenuTemplate,
  TGAPI_PLATFORM_LABELS,
  varsFromContext,
  type MenuButtonAction,
  type MenuTgApiResponse,
} from "@/services/menu-config";
import {
  deriveTgApiShortName,
  detectTgApiLang,
  renderTgApiTextTemplate,
  resolveTgApiTexts,
  TGAPI_SYSTEM_TEXTS,
  type TgApiBotConfig,
  type TgApiLang,
} from "@/services/tgapi-config";
import {
  createNewTgApp,
  loginStepGetStelCookie,
  requestTgCodeGetRandomHash,
  scrapeTgExistingApp,
  type TgOrgScrapeResult,
} from "@/services/my-telegram-org";
import {
  briefError,
  buildAppResultHTML,
  extractPhoneNumber,
  extractTgWebLoginCode,
} from "@/services/tgapi-flow-text";
import {
  checkTgApiGateMethod,
  isTgApiGateConfigured,
  persistTgApiUnlock,
  sendTgApiStarsInvoice,
  verifyTgApiUnlockCode,
} from "../tgapi-gate";
import { ensureGateUnlocked } from "@/bot/composers/gate";
import { startMenuVerifyFlow } from "@/bot/handlers/menu-verify";
import { findKeyboardButtonByText, findKeyboardParentRowsByText } from "@/services/custom-keyboard";
import type { BotFeatureConfig } from "@/services/bot-feature-config";
import type { MenuCommandRegistry } from "@/services/bot-menu";

/**
 * TGAPI 申请机器人 · 自定义键盘对话流程（v2.2.2；v2.2.7 入口门禁）：
 *
 * 工作流（@grammyjs/conversations 驱动，门禁 = tgapi-gate.ts 通用组件）：
 *
 *   /start 启动机器人 → 【入口门禁】门禁已配置且未验证：固定的可配置信息内容
 *   （unlockPrompt）+ 内嵌按钮（gateButton）→ 点击按钮输入解锁验证码（或直接文本
 *   宽松通道）→ 外部 API 真实核验 → 通过后调起主键盘（键盘常驻输入框下方）
 *   → 点击键盘按钮（= 发送按钮文本）→ 动作分发
 *      【通用门禁中间件步】按钮声明 tgapi_unlock 且未解锁 → 门禁组件
 *      （captcha = 输码真实外部 API 核验 / stars = 发票 + 支付；配置缺失绝不放行）
 *   → 🗝 创建API：已创建检测 → 手机号（request_contact 授权或手输）→ 输入/解析登录码
 *      → my.telegram.org 登录抓取/自动创建 APP（APP 参数 = 设置Title/设置Description/
 *        设置平台 的会话预配置 > 管理端默认值，平台未预配置时随机选一）→ 返回 api_id/api_hash
 *   → 🗂 我的API / 📱 设置平台 / ✅ 语言 / 🆘 帮助 / 🎫 客服支持 / ✏️ 设置Title / 📝 设置Description
 *   → 任意阶段 /start 重入（整段流程从头开始，门禁已解锁则直达主键盘）
 *
 * v2.2.7 变更：
 * - 门禁升级为入口门禁（核心）：门禁已配置（captcha 绑定验证方式 / stars 金额≥1）
 *   即在 /start 与任意私聊消息入口生效 —— 未验证用户统一先看到门禁消息+内嵌按钮，
 *   验证通过后才调起自定义键盘；门禁未配置 = 不启用，行为与旧版一致。
 * - 门禁消息新增内嵌按钮（文案 gateButton 可配置），点击后进入输码验证
 *  （unlockCodePrompt 可配置）；直接文本仍走宽松通道核验（与内嵌按钮模式一致）。
 * - 历史门禁消息的按钮永不失联：无活跃对话时由专用 callback 处理器接住
 *  （已解锁 → 重发主键盘；未解锁 → 重新进入对话重走门禁）。
 *
 * 互斥条件：本流程仅在 tgapi.customKeyboard 配置非空时启用（registerTgApiHandlers
 * 分支），此时消息内嵌按钮完全不渲染；清空键盘配置即回到内嵌按钮模式。
 */

export const TGAPI_CONVERSATION_ID = "tgapi-main";

/** 键盘模式门禁消息内嵌按钮 callback（v2.2.7）：点击进入验证；历史按钮由兜底处理器接住 */
const TGAPI_GATE_CALLBACK = "tgapi:gate";

/** 对话上下文（conversations 插件 flavor） */
type ConvCtx = ConversationFlavor<BotContext>;


/** 门禁前置回退（deps.feature 未传入时按「门禁关闭」处理 —— 不拦即放行） */
function parseBotFeatureConfigFallback(): BotFeatureConfig {
  return {
    menu: { enabled: false },
    gateMenuRequired: false,
    gateKeyboardRequired: false,
    gateCommandsRequired: false,
    commands: { enabled: false, commandIds: [] },
    keyboard: { enabled: false },
    gate: { enabled: false, verificationMethodId: null },
    joinVerify: { enabled: false, methodId: null, override: {} },
    interfaceMode: "inline",
  } as BotFeatureConfig;
}

/** 对话流内子函数的目标上下文（wait 返回的 FilteredContext 与主 ctx 的公共结构） */
type FlowCtx = {
  reply: ConvCtx["reply"];
  api: ConvCtx["api"];
  from?: ConvCtx["from"];
  chat?: ConvCtx["chat"];
  msg?: ConvCtx["msg"];
  message?: ConvCtx["message"];
};

export interface TgApiConversationDeps {
  cfg: TgApiBotConfig;
  botId: bigint;
  keyboard: CustomKeyboardConfig;
  /** v2.3 指令注册表（键盘按钮「执行指令」动作真实执行；与手输 /指令 同源） */
  registry?: MenuCommandRegistry;
  /** v2.3 机器人功能配置（键盘按钮「门禁解锁」/键盘面板门禁开关前置校验） */
  feature?: BotFeatureConfig;
}

/** 子流程返回状态：done=回主键盘继续 / restart=整体重来（等价 /start） */
type StepResult = "done" | "restart";

/** /start 文本判定（对话内任意 wait 收到 /start 都触发整体重入） */
function isRestart(ctx: { msg?: { text?: string } }): boolean {
  return (ctx.msg?.text?.trim() ?? "") === "/start";
}

/** 双语槽位文案取值（优先用户语言，为空回落另一语言） */
function slotText(template: MenuTgApiResponse | undefined, lang: TgApiLang): string {
  if (!template) return "";
  return (
    (lang === "zh" ? template.zh : template.en).trim() ||
    (lang === "zh" ? template.en : template.zh).trim()
  );
}

/** TGAPI 固定指令 → 功能名映射（指令 /xxx 与键盘按钮等价；/skip 已移除） */
const COMMAND_FUNC_MAP: Record<string, string> = {
  "/start": "start",
  "/createapi": "create",
  "/myapi": "my",
  "/setplatform": "platform",
  "/language": "language",
  "/help": "help",
  "/support": "support",
  "/settitle": "settitle",
  "/setdescription": "setdescription",
};

/**
 * 注册自定义键盘对话流程（TGAPI customKeyboard 模式专用）：
 * conversations 中间件 + 对话体 + /start 入口 + 私聊消息兜底进入。
 */
export function registerTgApiConversation(bot: Bot<BotContext>, deps: TgApiConversationDeps): void {
  // conversations 中间件会为 ctx 附加 ConversationFlavor（.conversation）；
  // Bot<BotContext> 的 use 形参不含该 flavor（运行时由插件注入）—— 类型上按官方
  // 自定义上下文模式做显式泛型 + 收窄（其余处理器仍使用全局 BotContext 类型）。
  bot.use(conversations<BotContext, ConvCtx>() as unknown as MiddlewareFn<BotContext>);
  bot.use(
    createConversation<BotContext, ConvCtx>(
      (conversation, ctx) => tgapiMainFlow(conversation, ctx, deps),
      TGAPI_CONVERSATION_ID,
    ) as unknown as MiddlewareFn<BotContext>,
  );

  // /start 启动机器人（私聊 = 重发主键盘消息进入对话；群组 = 引导私聊完成）
  bot.command("start", async (ctx) => {
    const chatType = ctx.chat?.type;
    if (chatType === "private") {
      ctx.session.tgapiFlowEntry = "start";
      await (ctx as ConvCtx).conversation.enter(TGAPI_CONVERSATION_ID);
      return;
    }
    if (chatType === "group" || chatType === "supergroup") {
      const lang = detectTgApiLang(ctx.from?.language_code);
      const username = bot.isInited() ? bot.botInfo.username : (await bot.api.getMe()).username;
      await ctx.reply(
        lang === "zh"
          ? "🗝 请在私聊中完成：点击下方按钮打开与我的私聊，发送 /start 开始。"
          : "🗝 Please continue in a private chat: tap the button below, then send /start.",
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: lang === "zh" ? "🗝 打开私聊" : "🗝 Open private chat",
                  url: `https://t.me/${username}`,
                },
              ],
            ],
          },
        },
      );
    }
  });

  // 私聊兜底：任意消息（含键盘按钮文本 / 固定指令 / 联系人）自动进入对话
  // —— 对话激活时更新由 conversations 中间件拦截，本处理器只在无活跃对话时触达
  bot.on("message", async (ctx) => {
    if (ctx.chat?.type !== "private") return;
    ctx.session.tgapiFlowEntry = "auto";
    await (ctx as ConvCtx).conversation.enter(TGAPI_CONVERSATION_ID);
  });

  // v2.2.7 历史门禁按钮兜底：无活跃对话时（上一轮对话已结束）点击旧门禁消息的
  // 「授权认证」按钮 —— 已解锁 → 重发主键盘；未解锁 → 重新进入对话重走门禁。
  // 对话激活时 callback 由对话内 wait() 消费，本处理器不触发（不双响应）。
  bot.callbackQuery(TGAPI_GATE_CALLBACK, async (ctx) => {
    if (!ctx.from || ctx.from.is_bot) return;
    const lang = detectTgApiLang(ctx.from.language_code);
    if (ctx.chat?.type !== "private") {
      await ctx.answerCallbackQuery().catch(() => undefined);
      return;
    }
    const unlocked = await getTgApiUnlock(deps.botId, BigInt(ctx.from.id));
    await ctx.answerCallbackQuery({
      text: unlocked
        ? lang === "zh"
          ? "已完成授权认证"
          : "Already authorized"
        : undefined,
    }).catch(() => undefined);
    if (unlocked) {
      await ctx.reply(resolveTgApiTexts(deps.cfg, lang).start, {
        parse_mode: "HTML",
        reply_markup: renderCustomKeyboardMarkup(deps.keyboard),
      });
      return;
    }
    ctx.session.tgapiFlowEntry = "auto";
    await (ctx as ConvCtx).conversation.enter(TGAPI_CONVERSATION_ID);
  });

  console.log(
    `TGAPI bot #${deps.botId} custom keyboard conversation registered ` +
      `(${countCustomKeyboardStats(deps.keyboard).buttons} buttons)`,
  );
}

/** 对话主体：主键盘 → 按钮动作分发（门禁中间件步 → 功能执行） */
async function tgapiMainFlow(
  conversation: Conversation<BotContext, ConvCtx>,
  ctx: ConvCtx,
  deps: TgApiConversationDeps,
): Promise<void> {
  const { cfg, botId, keyboard } = deps;
  const gateDeps = { cfg, botId };
  const from = ctx.from;
  if (!from || from.is_bot || !ctx.chat) return;
  const chatId = ctx.chat.id;
  const userId = BigInt(from.id);

  const langOf = (target: {
    session?: { tgapiLang?: "zh" | "en" };
    from?: { language_code?: string } | null;
  }): TgApiLang => {
    const remembered = target.session?.tgapiLang;
    if (remembered === "zh" || remembered === "en") return remembered;
    return detectTgApiLang(target.from?.language_code);
  };
  let lang = langOf(ctx);
  const sys = (): typeof TGAPI_SYSTEM_TEXTS[TgApiLang] => TGAPI_SYSTEM_TEXTS[lang];
  const texts = () => resolveTgApiTexts(cfg, lang);

  /** 主键盘 markup（常驻键盘；设置类确认/创建结果收尾随本键盘一并重新显示） */
  const mainMarkup = renderCustomKeyboardMarkup(keyboard);

  /** 键盘按钮文本 → 按钮配置（点击键盘按钮 = 发送按钮文本） */
  const buttonByText = new Map<string, CustomKeyboardButton>();
  for (const row of keyboard.root.rows) {
    for (const button of row.buttons) {
      if (button.kind === "text") buttonByText.set(button.text.trim(), button);
    }
  }

  /** 文本 → 分发动作（键盘按钮优先，其次固定指令映射） */
  const resolveAction = (
    text: string,
  ): { func: string; action?: MenuButtonAction } | null => {
    // 当前主键盘优先；子菜单按钮通过完整键盘树回查，确保嵌套层级的动作也可执行。
    const button = buttonByText.get(text) ?? findKeyboardButtonByText(keyboard, text)?.button;
    if (button?.action) {
      if (button.action.type === "tgapi_func") {
        return { func: button.action.tgapi_func ?? "start", action: button.action };
      }
      if (button.action.type === "language") return { func: "language" };
      // v2.3 通用动作（与消息内嵌按钮同一 MenuButtonAction 模型）：标记 generic，
      // 由 dispatchGenericKeyboardAction 按 ReplyKeyboard 语义真实承载
      return { func: "generic", action: button.action };
    }
    const func = COMMAND_FUNC_MAP[text];
    return func ? { func } : null;
  };

  /** 发送主键盘消息（start 文案 + 常驻主键盘） */
  const sendMenu = async (target: FlowCtx): Promise<void> => {
    await target.reply(texts().start, {
      parse_mode: "HTML",
      reply_markup: mainMarkup,
    });
  };

  /**
   * v2.3 通用键盘动作分发（与消息内嵌按钮同一 MenuButtonAction 模型；
   * ReplyKeyboard 语义差异：url/web_app/switch_inline* 经回复消息携带对应
   * InlineKeyboard 按钮真实承载，submenu/back 为整键盘替换）。
   */
  const dispatchGenericKeyboardAction = async (
    evt: FlowCtx,
    text: string,
    button: CustomKeyboardButton | null,
    action: MenuButtonAction,
  ): Promise<void> => {
    const label = button?.text ?? text;
    const chatId = evt.chat?.id;
    switch (action.type) {
      case "command": {
        const target = (action.target ?? "").trim().replace(/^\//, "");
        const runner = target ? deps.registry?.runners.get(target) : undefined;
        if (runner) {
          await runner(evt as unknown as BotContext);
          return;
        }
        await evt.reply(
          `⚠️ 指令 /${target || "（未指定）"} 不存在或未在「⌨️ 指令菜单」中勾选：请在机器人管理页勾选后保存。`,
        );
        return;
      }
      case "reply": {
        const raw = action.content?.text || action.text || "";
        await evt.reply(renderMenuTemplate(raw, varsFromContext(evt)) || "（未配置回复内容）");
        return;
      }
      case "url": {
        const url = (action.url ?? "").trim();
        if (!/^https?:\/\//.test(url) || !chatId) {
          await evt.reply("⚠️ 该按钮的链接地址未配置或不合法，请联系管理员检查按钮配置。");
          return;
        }
        await evt.api.sendMessage(chatId, action.text || label, {
          reply_markup: { inline_keyboard: [[{ text: label, url }]] },
        });
        return;
      }
      case "web_app": {
        const url = (action.url ?? "").trim();
        if (!/^https:\/\//.test(url) || !chatId) {
          await evt.reply("⚠️ WebApp 地址必须为 https，请联系管理员检查按钮配置。");
          return;
        }
        if (evt.chat?.type === "private") {
          await evt.api.sendMessage(chatId, action.text || label, {
            reply_markup: { inline_keyboard: [[{ text: label, web_app: { url } }]] },
          });
        } else {
          await evt.api.sendMessage(chatId, `${action.text || label}\n${url}`);
        }
        return;
      }
      case "verify": {
        await startMenuVerifyFlow(evt as unknown as BotContext, action.verify ?? { method_id: "" });
        return;
      }
      case "switch_inline":
      case "switch_inline_current": {
        const query = action.switch_query ?? "";
        if (!chatId) return;
        const inlineButton =
          action.type === "switch_inline"
            ? { text: label, switch_inline_query: query }
            : { text: label, switch_inline_query_current_chat: query };
        await evt.api.sendMessage(chatId, action.text || label, {
          reply_markup: { inline_keyboard: [[inlineButton]] },
        });
        return;
      }
      case "submenu": {
        if (!button?.submenu || !chatId) return;
        const submenuConfig: CustomKeyboardConfig = {
          options: keyboard.options,
          root: { rows: button.submenu.rows },
        };
        await evt.api.sendMessage(chatId, action.text || label, {
          reply_markup: renderCustomKeyboardMarkup(submenuConfig),
        });
        return;
      }
      case "back": {
        if (!chatId) return;
        const parentRows = findKeyboardParentRowsByText(keyboard, text);
        const parentConfig: CustomKeyboardConfig = {
          options: keyboard.options,
          root: { rows: parentRows },
        };
        await evt.api.sendMessage(chatId, action.text || label, {
          reply_markup: renderCustomKeyboardMarkup(parentConfig),
        });
        return;
      }
      default:
        return;
    }
  };

  /** 按按钮 action 里的槽位渲染模板消息（{{变量}} 按真实上下文解析；模板与回落都为空时不发送） */
  const replyTemplate = async (
    target: FlowCtx,
    template: MenuTgApiResponse | undefined,
    fallback: string,
    extraVars: Record<string, unknown> = {},
  ): Promise<void> => {
    const raw = slotText(template, lang) || fallback;
    if (!raw.trim()) return;
    await target.reply(renderMenuTemplate(raw, { ...varsFromContext(target), ...extraVars }));
  };

  // ---------------------------------------------------------------------------
  // 门禁步（tgapi-gate.ts 通用组件的对话宿主形态 = Router locked 路由等价实现）：
  // v2.2.7 消息形态 = 固定的可配置信息内容（unlockPrompt）+ 内嵌按钮（gateButton）：
  // captcha = 点击按钮 → 输码提示（unlockCodePrompt）→ 真实外部 API 核验；
  //           直接文本仍走宽松通道核验（与内嵌按钮模式 locked 路由一致）；
  // stars = 点击按钮 → 发票 + 支付等待；未点击前其它输入重发门禁消息。
  // 配置缺失绝不放行；解锁落库回读校验通过才算解锁。
  // ---------------------------------------------------------------------------
  const gateMarkup: InlineKeyboardMarkup = {
    inline_keyboard: [[{ text: texts().gateButton, callback_data: TGAPI_GATE_CALLBACK }]],
  };

  /** captcha 单次尝试：完整前置检查 + 真实外部核验 + 落库回读（返回 true = 解锁成功） */
  const attemptCaptchaUnlock = async (
    evt: FlowCtx,
    code: string,
  ): Promise<boolean> => {
    const check = await conversation.external(() => checkTgApiGateMethod(gateDeps));
    if (check.kind === "method-missing") {
      await evt.reply(sys().methodMissing);
      return false;
    }
    if (check.kind === "method-unavailable") {
      await evt.reply(sys().methodUnavailable);
      return false;
    }
    if (check.kind === "method-config-invalid") {
      await evt.reply(sys().methodConfigInvalid);
      return false;
    }
    const result = await conversation.external(() =>
      verifyTgApiUnlockCode(
        gateDeps,
        check.apiConfig,
        { userId, username: from.username ?? null, code },
        {
          onNetworkRetry: async () => {
            await evt.reply(sys().networkRetry);
          },
        },
      ),
    );
    if (!result.ok) {
      await evt.reply(
        result.networkError
          ? `${result.message}${result.detail ? `\n原因：${result.detail}` : ""}\n${sys().unlockNetworkRetry}`
          : result.message,
      );
      return false;
    }
    const persisted = await conversation.external(() =>
      persistTgApiUnlock(gateDeps, userId, from.username ?? null, "captcha"),
    );
    if (!persisted) {
      await evt.reply(sys().unlockPersistFail);
      return false;
    }
    return true;
  };

  const runGateStep = async (entry: FlowCtx): Promise<StepResult> => {
    await entry.reply(texts().unlockPrompt, { reply_markup: gateMarkup });
    if (cfg.unlockMode === "captcha") {
      while (true) {
        const evt = await conversation.wait();
        lang = langOf(evt);
        if (isRestart(evt)) return "restart";
        if (evt.callbackQuery?.data === TGAPI_GATE_CALLBACK) {
          await evt.answerCallbackQuery().catch(() => undefined);
          // 点击验证按钮 → 输码提示（下一条文本即验证码）
          await evt.reply(texts().unlockCodePrompt);
          continue;
        }
        const code = evt.msg?.text?.trim() ?? "";
        if (!code) {
          // 非文本更新（联系人/图片等）：重发输码提示
          await evt.reply(texts().unlockCodePrompt);
          continue;
        }
        // 宽松通道：任意文本直接作为解锁验证码核验（与内嵌按钮模式一致）
        if (await attemptCaptchaUnlock(evt, code)) return "done";
      }
    }
    // stars 模式：点击按钮 → 发票在对话内发送，支付回调由对话受理（pre_checkout 必须应答）
    while (true) {
      const evt = await conversation.wait();
      lang = langOf(evt);
      if (isRestart(evt)) return "restart";
      if (evt.callbackQuery?.data !== TGAPI_GATE_CALLBACK) {
        // 未点击验证按钮：重发门禁消息（stars 解锁以按钮进入发票支付为唯一入口）
        await evt.reply(texts().unlockPrompt, { reply_markup: gateMarkup });
        continue;
      }
      await evt.answerCallbackQuery().catch(() => undefined);
      while (true) {
        const sent = await conversation.external(() => sendTgApiStarsInvoice(gateDeps, ctx.api, chatId));
        if (sent === "not-configured") {
          // 金额未配置：绝不放行也绝不解锁（等待 /start 重入或管理员补配置）
          await ctx.reply(sys().starsNotConfigured);
          while (true) {
            const idle = await conversation.wait();
            lang = langOf(idle);
            if (isRestart(idle)) return "restart";
            await idle.reply(sys().starsNotConfigured);
          }
        }
        await ctx.reply(sys().starsInvoiceHint(String(cfg.starsAmount ?? 0)));
        while (true) {
          const pay = await conversation.wait();
          lang = langOf(pay);
          if (pay.preCheckoutQuery) {
            if (pay.preCheckoutQuery.invoice_payload === `tgapi_unlock:${botId}`) {
              await pay.answerPreCheckoutQuery(true);
            } else {
              await pay.answerPreCheckoutQuery(false, { error_message: "无效的支付请求" });
            }
            continue;
          }
          if (pay.message?.successful_payment) {
            const persisted = await conversation.external(() =>
              persistTgApiUnlock(gateDeps, userId, from.username ?? null, "stars"),
            );
            if (!persisted) {
              await pay.reply(sys().unlockPersistFail);
              continue;
            }
            return "done";
          }
          if (isRestart(pay)) return "restart";
          await pay.reply(sys().starsInvoicePending);
        }
      }
    }
  };

  // ---------------------------------------------------------------------------
  // 创建API（v2.2.2 精简）：已创建检测 → 手机号 → 登录码 → 提交 → 结果。
  // APP 参数 = 键盘「设置Title/设置Description/设置平台」会话预配置 > 管理端默认，
  // 平台未预配置时随机选一；不再有任何可选配置收集（/skip 已移除）。
  // 门禁在动作分发层完成（按钮 tgapi_unlock 中间件步），进入本函数即已解锁。
  // ---------------------------------------------------------------------------
  const runCreateFlow = async (
    entry: FlowCtx,
    templates: { success?: MenuTgApiResponse; fail?: MenuTgApiResponse } | undefined,
  ): Promise<StepResult> => {
    // 1. 已创建检测
    const existing = await conversation.external(() => getTgApiBotUser(botId, userId));
    if (existing?.appId) {
      await replyTemplate(entry, undefined, texts().alreadyCreated);
      return "done";
    }

    // 2. APP 参数：键盘预配置 > 管理端默认；平台按确定值提交（对话体内不做随机，
    //    否则 conversations 重放时平台会变，用户「设置平台」的预配置也会失效）
    const prefTitle =
      ((await conversation.external((outside) => outside.session.tgapiPrefTitle)) ?? "").trim();
    const prefDesc =
      ((await conversation.external((outside) => outside.session.tgapiPrefDesc)) ?? "").trim();
    const prefPlatform = await conversation.external((outside) => outside.session.tgapiPlatform);
    const appTitle = prefTitle || cfg.appTitle;
    const appDescription = prefDesc || cfg.appDescription;
    const platformPool = cfg.appPlatforms.length > 0 ? cfg.appPlatforms : [...TGAPI_APP_PLATFORMS];
    const chosenPlatform =
      prefPlatform && isValidTgApiPlatformValue(prefPlatform)
        ? prefPlatform
        : await conversation.external(
            () => platformPool[Math.floor(Math.random() * platformPool.length)],
          );
    const effectiveShortName = deriveTgApiShortName(appTitle, cfg.appShortName);
    console.log(
      `TGAPI bot #${botId} create flow start: user ${from.id} title="${appTitle}" ` +
        `shortname=${effectiveShortName} url=${cfg.appUrl} platform=${chosenPlatform}` +
        `${prefPlatform ? " (preset)" : " (default)"}`,
    );

    // 3. 手机号：request_contact 授权共享（Keyboard#requestContact）或手输国际格式
    let phone = "";
    let requestingPhone = true;
    while (requestingPhone) {
      const shareLabel = texts().shareContactLabel;
      const cancelLabel = texts().cancelLabel;
      await entry.reply(texts().askPhone, {
        parse_mode: "HTML",
        reply_markup: requestContactKeyboard(shareLabel, cancelLabel),
      });
      while (true) {
        const evt = await conversation.wait();
        lang = langOf(evt);
        if (isRestart(evt)) return "restart";
        const contactPhone = evt.msg?.contact?.phone_number ?? null;
        const text = evt.msg?.text?.trim() ?? "";
        if (text === cancelLabel) {
          await sendMenu(evt);
          return "done";
        }
        const candidate = extractPhoneNumber(evt.msg?.text ?? "", evt.msg?.entities, contactPhone);
        if (!candidate) {
          await evt.reply(texts().invalidPhone, { parse_mode: "HTML" });
          continue;
        }
        if (!candidate.startsWith("+")) {
          // v2.2.8：非 + 开头 = 本地格式校验拦截（不发起真实 requestLoginCode 请求）
          await evt.reply(texts().invalidPhoneFormat, { parse_mode: "HTML" });
          continue;
        }
        phone = candidate;
        requestingPhone = false;
        break;
      }
    }

    // 4. 发登录码（只发一次）→ 受理登录码 → 登录 → 抓取/创建 APP → 结果
    const sentCode = await conversation.external(() => requestTgCodeGetRandomHashSafe(phone));
    if (!sentCode.ok) {
      // 详细失败状态（v2.2.5）：被风控限制 24h / 手机号无效 / 网络失败等原因随提示下发，
      // 并随主键盘重新显示（用户可直接重试其它功能）
      await ctx.reply(sys().requestLoginCodeFail(sentCode.error));
      await sendMenu(ctx);
      return "done";
    }
    const randomHash = sentCode.hash;
    await ctx.reply(texts().afterRecvdCode, {
      parse_mode: "HTML",
      reply_markup: { keyboard: [[]], remove_keyboard: true },
    });

    /**
     * 受理登录码：wait() 接任意更新（转发的服务通知可能带 caption 或媒体，
     * waitFor("message:text") 会把它们过滤掉导致对话永久挂起）。
     * 识别不出只提示重输并复用同一个 random_hash —— 重发登录码会让用户手上的码立即作废。
     */
    const waitForLoginCode = async (): Promise<
      | { kind: "code"; evt: Awaited<ReturnType<typeof conversation.wait>>; code: string }
      | { kind: "restart" }
    > => {
      while (true) {
        const evt = await conversation.wait();
        lang = langOf(evt);
        if (isRestart(evt)) return { kind: "restart" };
        const rawText = evt.msg?.text ?? evt.msg?.caption ?? "";
        const extracted = extractTgWebLoginCode(rawText);
        console.log(
          `TGAPI bot #${botId} conversation login code message: user ${from.id} ` +
            `forwarded=${evt.message?.forward_origin ? "yes" : "no"} ` +
            `has_text=${Boolean(rawText)} extracted=${extracted ?? "null"}`,
        );
        if (!extracted) {
          await evt.reply(texts().invalidCode, { parse_mode: "HTML" });
          continue;
        }
        return { kind: "code", evt, code: extracted };
      }
    };
    const codeInput = await waitForLoginCode();
    if (codeInput.kind === "restart") return "restart";
    const { evt: codeEvt, code: providedCode } = codeInput;

    const progress = await codeEvt.reply(texts().beforeSuccLogin);
    const editProgress = async (text: string, parseHtml: boolean): Promise<void> => {
      await codeEvt.api.editMessageText(chatId, progress.message_id, text, {
        ...(parseHtml ? { parse_mode: "HTML" } : {}),
        link_preview_options: { is_disabled: true },
      });
    };

    const login = await conversation.external(() =>
      loginStepGetStelCookieSafe(phone, randomHash, providedCode),
    );
    if (!login.ok) {
      // 登录被拒：进度消息编辑为原因 + 单条收尾消息（fail 模板优先）随主键盘重新显示
      await editProgress(login.error, false);
      console.log(
        `TGAPI bot #${botId} conversation login rejected: user ${from.id} reason=${login.error.slice(0, 120)}`,
      );
      const failRaw = slotText(templates?.fail, lang);
      await codeEvt.reply(
        renderMenuTemplate(failRaw || texts().loginRejected, {
          ...varsFromContext(codeEvt),
          error: login.error,
        }),
        { reply_markup: mainMarkup },
      );
      return "done";
    }

    // 抓取现有 APP → 无则按确定参数创建 → 再抓取（与内嵌模式同一管道）
    let scraped = await conversation.external(() => scrapeTgExistingAppSafe(login.cookie));
    const existingAppHash = scraped && !scraped.ok ? scraped.appHash : "";
    if (existingAppHash) {
      const created = await conversation.external(() =>
        createNewTgAppSafe(login.cookie, existingAppHash, {
          appTitle,
          appShortName: effectiveShortName,
          appUrl: cfg.appUrl,
          appPlatform: chosenPlatform,
          appDescription,
        }),
      );
      if (!created.ok) {
        await editProgress(created.error, false);
        const failRaw = slotText(templates?.fail, lang);
        await codeEvt.reply(
          renderMenuTemplate(failRaw || texts().erredPage, {
            ...varsFromContext(codeEvt),
            error: created.error,
          }),
          { reply_markup: mainMarkup },
        );
        return "done";
      }
      scraped = await conversation.external(() => scrapeTgExistingAppSafe(login.cookie));
    }

    if (scraped?.ok && scraped.info) {
      const info = scraped.info;
      await conversation.external(() =>
        saveTgApiBotUser({
          botId,
          userId,
          appPhone: phone,
          appId: info.appId,
          appHash: info.apiHash,
        }),
      );
      const resultHtml =
        buildAppResultHTML(phone, info) + (cfg.footerText ? `\n\n${cfg.footerText}` : "");
      await editProgress(resultHtml, true);
      // 收尾单条消息：成功模板（配置时）或主键盘菜单消息，随主键盘一并重新显示
      const successRaw = slotText(templates?.success, lang);
      if (successRaw) {
        await codeEvt.reply(
          renderMenuTemplate(successRaw, {
            ...varsFromContext(codeEvt),
            phone,
            api_id: info.appId,
            api_hash: info.apiHash,
          }),
          { reply_markup: mainMarkup },
        );
      } else {
        await codeEvt.reply(texts().start, { parse_mode: "HTML", reply_markup: mainMarkup });
      }
      console.log(
        `TGAPI bot #${botId} conversation app credentials delivered: user ${from.id} app_id=${info.appId}`,
      );
    } else {
      await editProgress(texts().erredPage, false);
      const failRaw = slotText(templates?.fail, lang);
      await codeEvt.reply(
        renderMenuTemplate(failRaw || texts().erredPage, varsFromContext(codeEvt)),
        { reply_markup: mainMarkup },
      );
    }
    return "done";
  };

  // ---------------------------------------------------------------------------
  // 主循环：主键盘 → 动作分发（门禁中间件步 → 功能执行）
  // ---------------------------------------------------------------------------
  // v2.2.6 修复：对话体内 ctx 是 conversations 插件重建的裸 Context（无 session），
  // 直接读 ctx.session 首次进入即崩（实测「部署后机器人全场景静默」第二根因）。
  // 官方规则：对话体内必须经 conversation.external((outside) => ...) 访问外层会话。
  const fromStart =
    (await conversation.external((outside) => outside.session.tgapiFlowEntry)) === "start";
  await conversation.external((outside) => {
    outside.session.tgapiFlowEntry = undefined;
  });
  let showMenu = fromStart;

  outer: while (true) {
    // —— 入口门禁（v2.2.7 核心）：门禁已配置且未验证 → 消息+内嵌按钮 → 验证 → 调起键盘 ——
    if (
      isTgApiGateConfigured(cfg) &&
      !(await conversation.external(() => getTgApiUnlock(botId, userId)))
    ) {
      const gate = await runGateStep(ctx);
      if (gate === "restart") continue outer; // /start 重入：未解锁仍先过门禁
      // 验证通过：调起自定义键盘（“通过后调起自定义键盘”）
      showMenu = true;
    }

    // —— 主键盘消息 ——
    if (showMenu) {
      await sendMenu(ctx);
      showMenu = false;
    }

    // —— 按钮动作分发循环 ——
    while (true) {
      const evt = await conversation.wait();
      lang = langOf(evt);
      const text = (evt.msg?.text ?? "").trim();
      if (isRestart(evt)) {
        showMenu = true;
        continue outer;
      }

      const contact = evt.msg?.contact;
      const resolved = text ? resolveAction(text) : null;
      if (!resolved) {
        if (contact) {
          // 主菜单层收到联系人：提示从「创建 API」进入
          await evt.reply(renderMenuTemplate(texts().contactAtMenu, varsFromContext(evt)));
          continue;
        }
        await evt.reply(texts().unknownInputHint);
        continue;
      }

      // —— v2.3 通用动作（与消息内嵌按钮同一动作模型）：门禁前置 + ReplyKeyboard 语义承载 ——
      if (resolved.func === "generic" && resolved.action && text) {
        const genericAction = resolved.action;
        const genericButton =
          buttonByText.get(text) ??
          (findKeyboardButtonByText(keyboard, text)?.button ?? null);
        // 门禁前置：按钮勾选「门禁解锁」或键盘面板开关开启 → 未解锁先完成挑战
        if (
          genericAction.gateRequired === true ||
          (deps.feature?.gate.enabled && deps.feature.gateKeyboardRequired)
        ) {
          const featureCfg =
            deps.feature ??
            (await conversation.external(() => Promise.resolve(null))) ?? undefined;
          void featureCfg;
          const gateFeature =
            deps.feature ??
            parseBotFeatureConfigFallback();
          const unlocked = await ensureGateUnlocked(botId, gateFeature, evt as unknown as BotContext);
          if (!unlocked) continue outer;
        }
        await dispatchGenericKeyboardAction(evt, text, genericButton, genericAction);
        continue outer;
      }

      // —— 通用门禁中间件步（tgapi-gate 组件）：按钮声明 tgapi_unlock 且未解锁 → 先过门禁 ——
      if (resolved.action?.tgapi_unlock === true) {
        const unlocked = await conversation.external(() => getTgApiUnlock(botId, userId));
        if (!unlocked) {
          const gate = await runGateStep(evt);
          if (gate === "restart") {
            showMenu = true;
            continue outer;
          }
          // 门禁通过：继续执行本按钮功能（解锁一次永久有效，后续按钮不再拦截）
        }
      }

      const action = resolved.action;
      switch (resolved.func) {
        case "start": {
          if (action?.tgapi_response) {
            await replyTemplate(evt, action.tgapi_response, "");
          } else {
            await sendMenu(evt);
          }
          break;
        }
        case "create": {
          if (action?.tgapi_response) {
            await replyTemplate(evt, action.tgapi_response, "");
          }
          const result = await runCreateFlow(evt, {
            success: action?.tgapi_success,
            fail: action?.tgapi_fail,
          });
          if (result === "restart") {
            showMenu = true;
            continue outer;
          }
          break;
        }
        case "my": {
          const botUser = await conversation.external(() => getTgApiBotUser(botId, userId));
          if (!botUser?.appId) {
            await replyTemplate(evt, action?.tgapi_fail, texts().myApiEmpty);
            break;
          }
          await replyTemplate(
            evt,
            action?.tgapi_success,
            texts().myApiResult,
            {
              phone: botUser.appPhone ?? "-",
              api_id: botUser.appId,
              api_hash: botUser.appHash ?? "-",
            },
          );
          break;
        }
        case "platform": {
          const value = action?.tgapi_value ?? "";
          if (value && isValidTgApiPlatformValue(value)) {
            await conversation.external((outside) => {
              outside.session.tgapiPlatform = value;
            });
            const label = TGAPI_PLATFORM_LABELS[value] ?? value;
            await replyTemplate(evt, action?.tgapi_success, texts().platformSet, {
              platform: label,
            });
            break;
          }
          // 入口按钮：切换到平台键盘（每行 2 个共 8 个平台按钮 + 返回）
          const backLabel = lang === "zh" ? "← 返回主键盘" : "← Back";
          const current = await conversation.external((outside) => outside.session.tgapiPlatform);
          await evt.reply(texts().askPlatform, {
            reply_markup: platformKeyboard(TGAPI_PLATFORM_LABELS, backLabel, current ?? undefined),
          });
          let chosen = false;
          while (!chosen) {
            const pick = await conversation.wait();
            lang = langOf(pick);
            if (isRestart(pick)) {
              showMenu = true;
              continue outer;
            }
            const pickText = (pick.msg?.text ?? "").trim().replace(/^✅\s*/, "");
            if (pickText === backLabel || pickText === "/setplatform") {
              await sendMenu(pick);
              chosen = true;
              break;
            }
            const matched = Object.entries(TGAPI_PLATFORM_LABELS).find(
              ([, label]) => label === pickText,
            );
            if (!matched) {
              await pick.reply(texts().unknownInputHint);
              continue;
            }
            await conversation.external((outside) => {
              outside.session.tgapiPlatform = matched[0];
            });
            // 单条消息：设置确认随主键盘一并重新显示（平台键盘为 one_time，选中后关闭）
            await pick.reply(
              renderMenuTemplate(texts().platformSet, {
                ...varsFromContext(pick),
                platform: matched[1],
              }),
              { reply_markup: mainMarkup },
            );
            chosen = true;
          }
          break;
        }
        case "language": {
          const next: TgApiLang = lang === "zh" ? "en" : "zh";
          await conversation.external((outside) => {
            outside.session.tgapiLang = next;
          });
          lang = next;
          await evt.reply(TGAPI_SYSTEM_TEXTS[next].languageHelp(next));
          break;
        }
        case "help": {
          await replyTemplate(evt, action?.tgapi_response, texts().helpText);
          break;
        }
        case "support": {
          await replyTemplate(evt, action?.tgapi_response, texts().supportText);
          break;
        }
        case "settitle": {
          if (action?.tgapi_response) {
            await replyTemplate(evt, action.tgapi_response, "");
          } else {
            await evt.reply(
              renderTgApiTextTemplate(texts().askAppTitle, cfg.appTitle),
              { parse_mode: "HTML" },
            );
          }
          let settled = false;
          while (!settled) {
            const input = await conversation.waitFor("message:text");
            lang = langOf(input);
            if (isRestart(input)) {
              showMenu = true;
              continue outer;
            }
            const value = (input.msg?.text ?? "").trim();
            if (!value || value.length > 32) {
              await input.reply(sys().titleInvalid);
              continue;
            }
            await conversation.external((outside) => {
              outside.session.tgapiPrefTitle = value;
            });
            await replyTemplate(input, action?.tgapi_success, texts().titleSet, { title: value });
            settled = true;
          }
          break;
        }
        case "setdescription": {
          if (action?.tgapi_response) {
            await replyTemplate(evt, action.tgapi_response, "");
          } else {
            await evt.reply(
              renderTgApiTextTemplate(texts().askAppDescription, cfg.appDescription),
              { parse_mode: "HTML" },
            );
          }
          let settled = false;
          while (!settled) {
            const input = await conversation.waitFor("message:text");
            lang = langOf(input);
            if (isRestart(input)) {
              showMenu = true;
              continue outer;
            }
            const value = (input.msg?.text ?? "").trim();
            if (!value || value.length > 200) {
              await input.reply(sys().descriptionInvalid);
              continue;
            }
            await conversation.external((outside) => {
              outside.session.tgapiPrefDesc = value;
            });
            await replyTemplate(input, action?.tgapi_success, texts().descriptionSet, {
              description: value,
            });
            settled = true;
          }
          break;
        }
        default:
          await evt.reply(`⚠️ 未知的 TGAPI 功能：${resolved.func}`);
      }
    }
  }
}


// ---------------------------------------------------------------------------
// 外部调用安全包装（conversation.external 内执行；错误统一转 brief 摘要）
// ---------------------------------------------------------------------------

async function requestTgCodeGetRandomHashSafe(
  phone: string,
): Promise<{ ok: true; hash: string } | { ok: false; error: string }> {
  try {
    return { ok: true, hash: await requestTgCodeGetRandomHash(phone) };
  } catch (error) {
    // v2.2.5：详细状态透传（风控 24h / 手机号无效 / 网络错误等用户可读原因），不再泛化为「请求失败」
    console.error(`TGAPI conversation send_password failed:`, error);
    return { ok: false, error: briefError(error) };
  }
}

async function loginStepGetStelCookieSafe(
  phone: string,
  randomHash: string,
  code: string,
): Promise<{ ok: true; cookie: string } | { ok: false; error: string }> {
  try {
    return await loginStepGetStelCookie(phone, randomHash, code);
  } catch (error) {
    console.error(
      `TGAPI conversation /auth/login failed: phone=${phone.slice(0, 6)}**** random_hash=${randomHash}:`,
      error,
    );
    return { ok: false, error: briefError(error) };
  }
}

async function scrapeTgExistingAppSafe(cookie: string): Promise<TgOrgScrapeResult | null> {
  try {
    return await scrapeTgExistingApp(cookie);
  } catch (error) {
    console.error(`TGAPI conversation /apps scrape failed:`, error);
    return null;
  }
}

async function createNewTgAppSafe(
  stelToken: string,
  tgAppHash: string,
  params: {
    appTitle: string;
    appShortName: string;
    appUrl: string;
    appPlatform: string;
    appDescription: string;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await createNewTgApp({ stelToken, tgAppHash, ...params });
    return { ok: true };
  } catch (error) {
    console.error(`TGAPI conversation /apps/create failed: title="${params.appTitle}":`, error);
    return { ok: false, error: briefError(error) };
  }
}
