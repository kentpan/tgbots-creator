import { type Bot, type MiddlewareFn } from "grammy";
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
  persistTgApiUnlock,
  sendTgApiStarsInvoice,
  verifyTgApiUnlockCode,
} from "../tgapi-gate";

/**
 * TGAPI 申请机器人 · 自定义键盘对话流程（v2.2.2）：
 *
 * 工作流（@grammyjs/conversations 驱动，门禁 = tgapi-gate.ts 通用组件）：
 *
 *   /start 启动机器人 → 主键盘消息（键盘常驻输入框下方；无全局门禁拦截）
 *   → 点击键盘按钮（= 发送按钮文本）→ 动作分发
 *      【通用门禁中间件步】按钮声明 tgapi_unlock 且未解锁 → 门禁组件
 *      （captcha = 输码真实外部 API 核验 / stars = 发票 + 支付；配置缺失绝不放行）
 *   → 🗝 创建API：已创建检测 → 手机号（request_contact 授权或手输）→ 输入/解析登录码
 *      → my.telegram.org 登录抓取/自动创建 APP（APP 参数 = 设置Title/设置Description/
 *        设置平台 的会话预配置 > 管理端默认值，平台未预配置时随机选一）→ 返回 api_id/api_hash
 *   → 🗂 我的API / 📱 设置平台 / ✅ 语言 / 🆘 帮助 / 🎫 客服支持 / ✏️ 设置Title / 📝 设置Description
 *   → 任意阶段 /start 重入（整段流程从头开始）
 *
 * v2.2.2 变更：
 * - 创建API 精简：点击后直接手机号 → 验证码 → 提交，不再收集已有默认值的可选
 *   配置（askAppDetails 移除）；/skip 指令彻底移除。
 * - 双消息清理：门禁只发一条 unlockPrompt（输入提示移除）；解锁后直接进入下一步
 *  （单独成功消息移除）；设置类确认/创建结果收尾随主键盘一并重新显示（一条消息）。
 * - 门禁真实化：验证码必须真实调用外部验证 API；解锁落库回读校验；星星金额
 *   未配置绝不自动放行（核验核心与内嵌按钮模式共用 tgapi-gate.ts 同一实现）。
 *
 * 互斥条件：本流程仅在 tgapi.customKeyboard 配置非空时启用（registerTgApiHandlers
 * 分支），此时消息内嵌按钮完全不渲染；清空键盘配置即回到内嵌按钮模式。
 */

export const TGAPI_CONVERSATION_ID = "tgapi-main";

/** 对话上下文（conversations 插件 flavor） */
type ConvCtx = ConversationFlavor<BotContext>;

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
    const button = buttonByText.get(text);
    if (button?.action) {
      if (button.action.type === "tgapi_func") {
        return { func: button.action.tgapi_func ?? "start", action: button.action };
      }
      if (button.action.type === "language") return { func: "language" };
      return null; // reply/command 键盘动作用户自定义，TGAPI 流程不在此处理
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
  // captcha = 唯一门禁提示 + 输码真实外部 API 核验；stars = 发票 + 支付等待。
  // 配置缺失绝不放行；解锁落库回读校验通过才算解锁。
  // ---------------------------------------------------------------------------
  const runGateStep = async (entry: FlowCtx): Promise<StepResult> => {
    if (cfg.unlockMode === "captcha") {
      // 唯一门禁消息（v2.2.2：不再叠加「请在下方的输入框进行输入」输入提示）
      await entry.reply(texts().unlockPrompt);
      while (true) {
        const evt = await conversation.wait();
        lang = langOf(evt);
        if (isRestart(evt)) return "restart";
        const code = evt.msg?.text?.trim() ?? "";
        if (!code) continue;
        const check = await conversation.external(() => checkTgApiGateMethod(gateDeps));
        if (check.kind === "method-missing") {
          await evt.reply(sys().methodMissing);
          continue;
        }
        if (check.kind === "method-unavailable") {
          await evt.reply(sys().methodUnavailable);
          continue;
        }
        if (check.kind === "method-config-invalid") {
          await evt.reply(sys().methodConfigInvalid);
          continue;
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
          continue;
        }
        const persisted = await conversation.external(() =>
          persistTgApiUnlock(gateDeps, userId, from.username ?? null, "captcha"),
        );
        if (!persisted) {
          await evt.reply(sys().unlockPersistFail);
          continue;
        }
        return "done";
      }
    }
    // stars 模式：发票在对话内发送，支付回调由对话受理（pre_checkout 必须应答）
    while (true) {
      const sent = await conversation.external(() => sendTgApiStarsInvoice(gateDeps, ctx.api, chatId));
      if (sent === "not-configured") {
        // 金额未配置：绝不放行也绝不解锁（等待 /start 重入或管理员补配置）
        await ctx.reply(sys().starsNotConfigured);
        while (true) {
          const evt = await conversation.wait();
          lang = langOf(evt);
          if (isRestart(evt)) return "restart";
          await evt.reply(sys().starsNotConfigured);
        }
      }
      await ctx.reply(sys().starsInvoiceHint(String(cfg.starsAmount ?? 0)));
      while (true) {
        const evt = await conversation.wait();
        lang = langOf(evt);
        if (evt.preCheckoutQuery) {
          if (evt.preCheckoutQuery.invoice_payload === `tgapi_unlock:${botId}`) {
            await evt.answerPreCheckoutQuery(true);
          } else {
            await evt.answerPreCheckoutQuery(false, { error_message: "无效的支付请求" });
          }
          continue;
        }
        if (evt.message?.successful_payment) {
          const persisted = await conversation.external(() =>
            persistTgApiUnlock(gateDeps, userId, from.username ?? null, "stars"),
          );
          if (!persisted) {
            await evt.reply(sys().unlockPersistFail);
            continue;
          }
          return "done";
        }
        if (isRestart(evt)) return "restart";
        await evt.reply(sys().starsInvoicePending);
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

    // 2. APP 参数：键盘预配置 > 管理端默认；平台未预配置 → 随机选一（对应原 random.choice）
    const prefTitle = (await conversation.external(() => ctx.session.tgapiPrefTitle))?.trim() ?? "";
    const prefDesc = (await conversation.external(() => ctx.session.tgapiPrefDesc))?.trim() ?? "";
    const prefPlatform = await conversation.external(() => ctx.session.tgapiPlatform);
    const appTitle = prefTitle || cfg.appTitle;
    const appDescription = prefDesc || cfg.appDescription;
    const platformPool = cfg.appPlatforms.length > 0 ? cfg.appPlatforms : [...TGAPI_APP_PLATFORMS];
    const chosenPlatform =
      prefPlatform && isValidTgApiPlatformValue(prefPlatform)
        ? prefPlatform
        : platformPool[Math.floor(Math.random() * platformPool.length)];
    const effectiveShortName = deriveTgApiShortName(appTitle, cfg.appShortName);
    console.log(
      `TGAPI bot #${botId} create flow start: user ${from.id} title="${appTitle}" ` +
        `platform=${chosenPlatform}${prefPlatform ? " (preset)" : " (random)"}`,
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
          return "done";
        }
        const candidate = extractPhoneNumber(evt.msg?.text ?? "", evt.msg?.entities, contactPhone);
        if (!candidate) {
          await evt.reply(texts().invalidPhone, { parse_mode: "HTML" });
          continue;
        }
        phone = candidate;
        requestingPhone = false;
        break;
      }
    }

    // 4. 登录码（单独验证码或从固定信息中提取）→ 登录 → 抓取/创建 APP → 结果
    while (true) {
      const randomHash = await conversation.external(() => requestTgCodeGetRandomHashSafe(phone));
      if (randomHash === null) {
        await ctx.reply(sys().requestLoginCodeFail("请求失败，请稍后重试"));
        await sendMenu(ctx);
        return "done";
      }
      await ctx.reply(texts().afterRecvdCode, {
        parse_mode: "HTML",
        reply_markup: { keyboard: [[]], remove_keyboard: true },
      });
      const codeEvt = await conversation.waitFor("message:text");
      lang = langOf(codeEvt);
      if (isRestart(codeEvt)) return "restart";
      const providedCode = extractTgWebLoginCode(codeEvt.msg?.text ?? "");
      console.log(
        `TGAPI bot #${botId} conversation login code received: user ${from.id} ` +
          `forwarded=${codeEvt.message?.forward_origin ? "yes" : "no"} extracted=${providedCode ? "yes" : "no"}`,
      );
      if (!providedCode) {
        await codeEvt.reply(texts().invalidCode, { parse_mode: "HTML" });
        continue;
      }

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
        await editProgress(login.error || texts().erredPage, false);
        console.log(
          `TGAPI bot #${botId} conversation login rejected: user ${from.id} reason=${(login.error ?? "").slice(0, 120)}`,
        );
        const failRaw = slotText(templates?.fail, lang);
        await codeEvt.reply(
          renderMenuTemplate(
            failRaw || texts().loginRejected,
            {
              ...varsFromContext(codeEvt),
              error: login.error ?? "my.telegram.org 登录被拒绝",
            },
          ),
          { reply_markup: mainMarkup },
        );
        return "done";
      }

      // 抓取现有 APP → 无则按参数创建 → 再抓取（与内嵌模式同一管道）
      let scraped = await conversation.external(() => scrapeTgExistingAppSafe(login.cookie));
      const existingAppHash = scraped && !scraped.ok ? (scraped.appHash ?? "") : "";
      if (existingAppHash) {
        await conversation.external(() =>
          createNewTgAppSafe(login.cookie, existingAppHash, {
            appTitle,
            appShortName: effectiveShortName,
            appUrl: cfg.appUrl,
            appPlatforms: [chosenPlatform],
            appDescription,
          }),
        );
        scraped = await conversation.external(() => scrapeTgExistingAppSafe(login.cookie));
      }

      if (scraped?.ok && scraped.info) {
        await conversation.external(() =>
          saveTgApiBotUser({
            botId,
            userId,
            appPhone: phone,
            appId: scraped?.info?.appId ?? "",
            appHash: scraped?.info?.apiHash ?? "",
          }),
        );
        const resultHtml =
          buildAppResultHTML(phone, scraped.info) + (cfg.footerText ? `\n\n${cfg.footerText}` : "");
        await editProgress(resultHtml, true);
        // 收尾单条消息：成功模板（配置时）或主键盘菜单消息，随主键盘一并重新显示
        const successRaw = slotText(templates?.success, lang);
        if (successRaw) {
          await codeEvt.reply(
            renderMenuTemplate(successRaw, {
              ...varsFromContext(codeEvt),
              phone,
              api_id: scraped.info.appId,
              api_hash: scraped.info.apiHash,
            }),
            { reply_markup: mainMarkup },
          );
        } else {
          await codeEvt.reply(texts().start, { parse_mode: "HTML", reply_markup: mainMarkup });
        }
        console.log(
          `TGAPI bot #${botId} conversation app credentials delivered: user ${from.id} app_id=${scraped.info.appId}`,
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
    }
  };

  // ---------------------------------------------------------------------------
  // 主循环：主键盘 → 动作分发（门禁中间件步 → 功能执行）
  // ---------------------------------------------------------------------------
  const fromStart = ctx.session.tgapiFlowEntry === "start";
  ctx.session.tgapiFlowEntry = undefined;
  let showMenu = fromStart;

  outer: while (true) {
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
            ctx.session.tgapiPlatform = value;
            const label = TGAPI_PLATFORM_LABELS[value] ?? value;
            await replyTemplate(evt, action?.tgapi_success, texts().platformSet, {
              platform: label,
            });
            break;
          }
          // 入口按钮：切换到平台键盘（每行 2 个共 8 个平台按钮 + 返回）
          const backLabel = lang === "zh" ? "← 返回主键盘" : "← Back";
          const current = await conversation.external(() => ctx.session.tgapiPlatform);
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
            ctx.session.tgapiPlatform = matched[0];
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
          ctx.session.tgapiLang = next;
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
            ctx.session.tgapiPrefTitle = value;
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
            ctx.session.tgapiPrefDesc = value;
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

async function requestTgCodeGetRandomHashSafe(phone: string): Promise<string | null> {
  try {
    return await requestTgCodeGetRandomHash(phone);
  } catch (error) {
    console.error(`TGAPI conversation send_password failed:`, error);
    return null;
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
    appPlatforms: string[];
    appDescription: string;
  },
): Promise<void> {
  try {
    await createNewTgApp({ stelToken, tgAppHash, ...params });
  } catch (error) {
    console.error(`TGAPI conversation /apps/create failed:`, error);
  }
}
