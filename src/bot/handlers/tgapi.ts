import { Bot } from "grammy";
import type { InlineKeyboardMarkup, MessageEntity } from "grammy/types";
import { CommandGroup } from "@grammyjs/commands";
import { StatelessQuestion } from "@grammyjs/stateless-question";
import type { BotContext } from "../context";
import { htmlEscape } from "@/utils/html";
import {
  getTgApiUnlock,
  getVerificationMethod,
  listBotCommandsByIds,
  saveTgApiUnlock,
} from "@/database/operations";
import {
  parseCodeApiConfig,
  verifyCodeExternally,
} from "@/services/external-verify";
import {
  countMenuStats,
  renderMenuMarkup,
  scopeCommandRunnerToGroup,
  type MenuCommandRegistry,
  type MenuCommandRunner,
} from "@/services/bot-menu";
import type { BotMenuConfig } from "@/services/bot-menu";
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
  extractTgWebLoginCode,
  loginStepGetStelCookie,
  requestTgCodeGetRandomHash,
  scrapeTgExistingApp,
  type TgAppInfo,
  type TgOrgScrapeResult,
} from "@/services/my-telegram-org";
import { registerBuiltinCommandHandlers } from "./builtin-commands";

/**
 * TGAPI申请 机器人（v2.1.10）—— my.telegram.org APP 申请对话流程 +
 * 按钮驱动交互（参照 My-Telegram-Api-Bot 交互形态重做门禁体验）。
 *
 * 申请状态机（原 SpEcHiDe/MyTelegramOrgRoBot ConversationHandler 1:1 移植）：
 * 手机号 ──▶ POST /auth/send_password → random_hash（会话落库）
 *         ──▶ AFTER_RECVD_CODE_TEXT（等待 Telegram 登录码）
 * 登录码 ──▶ POST /auth/login → stel_token Cookie ──▶ GET /apps 抓取
 *         ├─ 已有 APP → 解析 app_id/api_hash/MTProto 服务器 → 结果消息
 *         └─ 无 APP   → POST /apps/create（APP 参数）→ 重新抓取 → 结果消息
 * /start 在任意阶段重入（fallback 语义一致）。
 *
 * v2.1.10 按钮驱动流程（详见 registerTgApiHandlers 注释）：
 * /start（未解锁）──▶ 欢迎文案 + 「🔐 授权认证」内嵌按钮
 * 点按钮 ──▶ force-reply 要求在输入框输入验证码 ──▶ 外部 API 核验
 * 通过   ──▶ 验证成功消息 + 管理端「消息内嵌按钮」配置渲染的菜单键盘
 * （每个按钮对应一个 /xxx 指令，点击等同手输指令；需要输入的在输入框输入，
 * 可选择的用内嵌按钮列出；指令只在「⌨️ 指令菜单」弹窗勾选后才注册响应）。
 * 群组 /start@本机器人 同样响应欢迎消息（群内授权引导私聊完成）。
 *
 * v2.1.10 文案与默认值全面中性化：不再携带原项目作者 SpEcHlDe/UseTGxBot
 * 的推广链接、自建部署宣传与署名（历史配置中的旧垃圾常量读取时自动迁移）。
 *
 * 历史变更（保留语义）：
 * - v2.1.7：中英文双语 + /language 切换；申请人自定义 APP（askAppDetails）；
 *   解锁一次永久有效（tgapi_unlocks，管理端手动撤销除外）。
 * - v2.1.6 增值门禁：captcha=外部 API 验证码（verifyCodeExternally）/
 *   stars=Telegram 星星支付发票（sendInvoice XTR）两种解锁方式。
 */

/** 星星支付发票 payload 前缀 */
const UNLOCK_PAYLOAD_PREFIX = "tgapi_unlock:";

/** 解锁无状态问题 id（每个 TGAPI 机器人实例独立安装，互不串扰） */
const TGAPI_UNLOCK_QUESTION_ID = "tgapi-unlock";

/** 欢迎消息「🔐 授权认证」内嵌按钮 callback（v2.1.10） */
const TGAPI_UNLOCK_CALLBACK = "tgapi:unlock";

/** 申请人自定义 APP 名称/描述的长度上限（my.telegram.org 表单约束） */
const APP_TITLE_MAX_LENGTH = 32;
const APP_DESCRIPTION_MAX_LENGTH = 200;

/**
 * get_phno_imn_ges 原样移植：提取国际格式手机号。
 * 优先级：phone_number 实体片段（Telegram 已校验）＞ 联系人号码 ＞ 原文。
 */
function extractPhoneNumber(
  messageText: string,
  entities: MessageEntity[] | undefined,
  contactPhone: string | null,
): string | null {
  if (entities && entities.length > 0) {
    for (const entity of entities) {
      if (entity.type === "phone_number") {
        return messageText.slice(entity.offset, entity.offset + entity.length).trim();
      }
    }
  }
  if (contactPhone && contactPhone.trim()) {
    return contactPhone.trim();
  }
  return null;
}

/**
 * parse_to_meaning_ful_text 原样移植：把抓取结果组装为 Telegram HTML 消息。
 * 结构与原实现逐字一致（Phone Number / App Configuration / Available MTProto
 * Servers / Disclaimer），占位值做 HTML 转义（原实现未转义，这里只加固不改变结构）。
 */
function buildAppResultHTML(phone: string, info: TgAppInfo): string {
  return (
    "<i>Phone Number</i>: " +
    `<u>${htmlEscape(phone)}</u>` +
    "\n\n" +
    "<i>App Configuration</i>\n" +
    "<b>APP ID</b>: " +
    `<code>${htmlEscape(info.appId)}</code>` +
    "\n" +
    "<b>API HASH</b>: " +
    `<code>${htmlEscape(info.apiHash)}</code>` +
    "\n\n" +
    "<i>Available MTProto Servers</i>\n" +
    "<b>Production Configuration</b>: " +
    `<code>${htmlEscape(info.productionConfiguration.ip)}</code> <u>${htmlEscape(info.productionConfiguration.dc)}</u>` +
    "\n" +
    "<b>Test Configuration</b>: " +
    `<code>${htmlEscape(info.testConfiguration.ip)}</code> <u>${htmlEscape(info.testConfiguration.dc)}</u>` +
    "\n\n" +
    "<i>Disclaimer</i>: " +
    "<u>It is forbidden to pass this value to third parties.</u>"
  );
}

/** TGAPI 机器人错误详情的终端截断长度（详细日志进 dev.log，用户侧截断展示） */
function briefError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

/**
 * 注册 TGAPI申请 机器人全部能力（multi-runtime 专用入口）。
 *
 * v2.1.10 按钮驱动新流程（参照 My-Telegram-Api-Bot 交互形态）：
 * - /start（私聊，未解锁）：图3 欢迎文案 + 底部内嵌按钮「🔐 授权认证」；
 * - 点「授权认证」→ force-reply 要求在输入框输入验证码（需要输入的在输入框输入）；
 * - 核验通过 → 验证成功消息 + 管理端「消息内嵌按钮」配置真实渲染的菜单键盘
 *   （图4：每个按钮对应一个 /xxx 指令，可以选择的用内嵌按钮列出供选择）；
 * - 「执行指令」按钮点击等同用户手输 /指令：与「⌨️ 指令菜单」弹窗勾选同源真实执行
 *   （v2.1.11：指令注册唯一来源 = 指令菜单弹窗勾选，bots.config.commandIds；
 *   运行时绝不按指令库启用状态自行补注册，未勾选的指令一律不响应）；
 * - /start（群组）：同样响应欢迎消息（v2.1.10 修复群里 /start@机器人无响应），
 *   群内点「授权认证」引导私聊完成（验证码绝不在群里输入，避免泄露）。
 *
 * 返回指令同步任务（/start + /language + 弹窗勾选指令同步到 Telegram 指令菜单）。
 */
export interface TgApiHandlerOptions {
  /** 该机器人「消息内嵌按钮」配置（bots.menu_config）：解锁成功后随消息真实渲染 */
  menuConfig: BotMenuConfig;
  /** 菜单「执行指令」按钮的指令运行器注册表（multi-runtime 按实例创建） */
  registry: MenuCommandRegistry;
  /** 「⌨️ 指令菜单」弹窗勾选的指令库条目 id（bots.config.commandIds）：指令注册唯一来源 */
  commandIds: number[];
}

export async function registerTgApiHandlers(
  bot: Bot<BotContext>,
  cfg: TgApiBotConfig,
  botId: bigint,
  options: TgApiHandlerOptions,
): Promise<() => Promise<void>> {
  const { menuConfig, registry } = options;

  /** 会话语言偏好优先，未设置按用户 language_code 自动识别（zh* → 中文） */
  function langOf(ctx: BotContext): TgApiLang {
    const remembered = ctx.session.tgapiLang;
    if (remembered === "zh" || remembered === "en") return remembered;
    return detectTgApiLang(ctx.from?.language_code);
  }

  // ---------------------------------------------------------------------------
  // 解锁门禁：外部 API 验证码（stateless-question force_reply，与加群验证同款交互）
  // ---------------------------------------------------------------------------
  const unlockQuestion = new StatelessQuestion<BotContext>(
    TGAPI_UNLOCK_QUESTION_ID,
    async (ctx) => {
      const from = ctx.from;
      const lang = langOf(ctx);
      const code = ctx.message?.text?.trim() ?? "";
      if (!from || from.is_bot || !code) return;
      const unlocked = await getTgApiUnlock(botId, BigInt(from.id));
      if (unlocked) {
        // 用户回复的是历史解锁提示：已解锁则引导直接开始（不重复核验，解锁一次永久有效）
        if (!ctx.session.tgapi?.state) {
          await beginApplication(ctx, lang);
        }
        return;
      }
      await handleUnlockAttempt(ctx, lang, code);
    },
  );

  /** 外部 API 核验解锁码（复用加群验证机器人 code_api 外部 API 验证的同一实现） */
  async function handleUnlockAttempt(ctx: BotContext, lang: TgApiLang, code: string): Promise<void> {
    const from = ctx.from;
    if (!from) return;
    const sys = TGAPI_SYSTEM_TEXTS[lang];
    if (cfg.unlockMode !== "captcha") {
      await ctx.reply(sys.switchedToStars);
      return;
    }
    if (!cfg.verificationMethodId) {
      await ctx.reply(sys.methodMissing);
      return;
    }
    const method = await getVerificationMethod(BigInt(cfg.verificationMethodId));
    if (!method || !method.enabled) {
      await ctx.reply(sys.methodUnavailable);
      return;
    }
    const apiConfig = parseCodeApiConfig(method.config);
    if (!apiConfig) {
      console.error(
        `TGAPI bot #${botId} unlock method ${method.id} has invalid code API config`,
      );
      await ctx.reply(sys.methodConfigInvalid);
      return;
    }
    const result = await verifyCodeExternally(
      apiConfig,
      { userId: BigInt(from.id), username: from.username ?? null, code },
      {
        onNetworkRetry: async () => {
          await ctx.reply(sys.networkRetry);
        },
      },
    );
    if (!result.ok) {
      // 与验证码输入通道同口径：网络故障不计入用户侧任何代价，明确说明；
      // v2.1.8：网络故障附带具体原因（如「连接被拒绝（验证接口服务未启动）」），便于管理员排查
      await ctx.reply(
        result.networkError
          ? `${result.message}${result.detail ? `\n原因：${result.detail}` : ""}\n${sys.unlockNetworkRetry}`
          : result.message,
      );
      console.log(
        `TGAPI bot #${botId} unlock rejected: user ${from.id} networkError=${result.networkError} reason=${result.message}${result.detail ? ` detail=${result.detail}` : ""}`,
      );
      return;
    }
    await saveTgApiUnlock({
      botId,
      userId: BigInt(from.id),
      username: from.username ?? null,
      mode: "captcha",
    });
    ctx.session.tgapiStarsInvoiceSent = false;
    // v2.1.10：验证成功消息 + 图4 菜单内嵌按钮（管理端配置真实渲染）
    await sendUnlockSuccessWithMenu(ctx, lang);
    console.log(
      `TGAPI bot #${botId} unlocked via captcha: user ${from.id} (${from.username ?? "no username"})`,
    );
  }

  /** 发送星星解锁发票（Telegram Stars / XTR） */
  async function sendStarsInvoice(ctx: BotContext, lang: TgApiLang): Promise<void> {
    if (!ctx.chat) return;
    const sys = TGAPI_SYSTEM_TEXTS[lang];
    const amount = cfg.starsAmount ?? 0;
    if (amount < 1) {
      await ctx.reply(sys.starsNotConfigured);
      return;
    }
    await ctx.api.sendInvoice(
      ctx.chat.id,
      (cfg.starsTitle?.trim() || "TGAPI 解锁").slice(0, 32),
      "首次使用 TGAPI 申请机器人前的一次性解锁".slice(0, 255),
      `${UNLOCK_PAYLOAD_PREFIX}${botId}`,
      // Telegram Stars：currency 固定 XTR，provider_token 必须为空字符串
      "XTR",
      [{ label: "TGAPI 解锁", amount }],
      { provider_token: "" },
    );
    ctx.session.tgapiStarsInvoiceSent = true;
    console.log(
      `TGAPI bot #${botId} stars invoice sent: user ${ctx.from?.id ?? "?"} amount=${amount} XTR`,
    );
  }

  /**
   * /start 欢迎消息（未解锁用户）：图3 文案 + 底部内嵌按钮「🔐 授权认证」。
   * 私聊与群组共用；群组点击按钮由 callback 处理器引导私聊完成。
   */
  async function sendUnlockEntry(ctx: BotContext, lang: TgApiLang): Promise<void> {
    const texts = resolveTgApiTexts(cfg, lang);
    await ctx.reply(texts.start, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "🔐 授权认证", callback_data: TGAPI_UNLOCK_CALLBACK }]],
      } satisfies InlineKeyboardMarkup,
    });
  }

  /**
   * 解锁成功消息（v2.1.10 图4）：验证成功文案 + 管理端「消息内嵌按钮」配置
   * 真实渲染的菜单键盘（每个按钮对应一个 /xxx 指令，点击等同手输指令）。
   * 管理端未配置按钮时自动进入申请流程，机器人绝不出现“没反应”状态。
   */
  async function sendUnlockSuccessWithMenu(ctx: BotContext, lang: TgApiLang): Promise<void> {
    const texts = resolveTgApiTexts(cfg, lang);
    await ctx.reply(texts.unlockSuccess);
    if (countMenuStats(menuConfig.root).buttons === 0) {
      console.log(
        `TGAPI bot #${botId} menu config empty -> fallback to beginApplication after unlock`,
      );
      await beginApplication(ctx, lang);
      return;
    }
    const markup = await renderMenuMarkup(menuConfig, bot, registry);
    await ctx.reply(
      lang === "zh" ? "👇 请选择下面的方式之一：" : "👇 Please choose one of the options below:",
      { reply_markup: markup },
    );
  }

  /**
   * 开始申请流程（已解锁用户）：askAppDetails 开启时先收集 APP 名称/描述
   * （申请人自定义，/skip 用管理端默认），否则直接进入手机号状态（原版行为）。
   */
  async function beginApplication(ctx: BotContext, lang: TgApiLang): Promise<void> {
    const texts = resolveTgApiTexts(cfg, lang);
    ctx.session.tgapi = cfg.askAppDetails ? { state: "title" } : { state: "phone" };
    if (cfg.askAppDetails) {
      await ctx.reply(
        renderTgApiTextTemplate(texts.askAppTitle, cfg.appTitle),
        { parse_mode: "HTML" },
      );
    } else {
      // askAppDetails 关闭：直接进入手机号输入（需要输入的在输入框输入）
      await ctx.reply(texts.askPhone, { parse_mode: "HTML" });
    }
  }

  /** /start 入口（对应原 ConversationHandler entry_point + fallback；仅私聊） */
  async function startConversation(ctx: BotContext): Promise<void> {
    const from = ctx.from;
    if (!from || from.is_bot) return;
    const lang = langOf(ctx);
    const sys = TGAPI_SYSTEM_TEXTS[lang];
    const unlocked = await getTgApiUnlock(botId, BigInt(from.id));
    if (unlocked) {
      await beginApplication(ctx, lang);
      return;
    }
    // 首次对话门禁：未解锁先授权认证（v2.1.10：欢迎文案 + 授权认证内嵌按钮）
    if (cfg.unlockMode === "captcha") {
      await sendUnlockEntry(ctx, lang);
      return;
    }
    await sendStarsInvoice(ctx, lang);
    await ctx.reply(sys.starsInvoiceHint(String(cfg.starsAmount ?? "-")));
  }

  /** 推进到 APP 描述步骤（title 收集完成后共用） */
  async function advanceToDescription(ctx: BotContext, lang: TgApiLang): Promise<void> {
    const texts = resolveTgApiTexts(cfg, lang);
    ctx.session.tgapi = {
      ...ctx.session.tgapi,
      state: "desc",
    };
    await ctx.reply(
      renderTgApiTextTemplate(texts.askAppDescription, cfg.appDescription),
      { parse_mode: "HTML" },
    );
  }

  /** 推进到手机号步骤（APP 名称/描述收集完成或跳过后共用） */
  async function advanceToPhone(ctx: BotContext, lang: TgApiLang): Promise<void> {
    const texts = resolveTgApiTexts(cfg, lang);
    ctx.session.tgapi = {
      ...ctx.session.tgapi,
      state: "phone",
    };
    await ctx.reply(texts.askPhone, { parse_mode: "HTML" });
  }

  /** INPUT_PHONE_NUMBER 状态：受理手机号/联系人，请求发送登录码 */
  async function handlePhoneInput(
    ctx: BotContext,
    lang: TgApiLang,
    messageText: string | null,
    contactPhone: string | null,
  ): Promise<void> {
    const from = ctx.from;
    if (!from) return;
    const texts = resolveTgApiTexts(cfg, lang);
    const sys = TGAPI_SYSTEM_TEXTS[lang];
    const phone = extractPhoneNumber(
      messageText ?? "",
      ctx.message?.entities,
      contactPhone,
    );
    if (!phone) {
      // 原实现：无法提取手机号 → IN_VALID_PHNO_PVDED，停留 INPUT_PHONE_NUMBER
      await ctx.reply(texts.invalidPhone, { parse_mode: "HTML" });
      return;
    }
    try {
      const randomHash = await requestTgCodeGetRandomHash(phone);
      ctx.session.tgapi = { ...ctx.session.tgapi, state: "code", phone, randomHash };
      await ctx.reply(texts.afterRecvdCode, { parse_mode: "HTML" });
      console.log(
        `TGAPI bot #${botId} login code requested: user ${from.id} phone=${phone.slice(0, 6)}****`,
      );
    } catch (error) {
      console.error(
        `TGAPI bot #${botId} send_password failed: user ${from.id} phone=${phone.slice(0, 6)}****:`,
        error,
      );
      await ctx.reply(sys.requestLoginCodeFail(briefError(error)));
    }
  }

  /** INPUT_TG_CODE 状态：受理登录码 → 登录 → 抓取/创建 APP → 结果消息 */
  async function handleCodeInput(ctx: BotContext, lang: TgApiLang, messageText: string): Promise<void> {
    const from = ctx.from;
    const flow = ctx.session.tgapi;
    if (!from) return;
    const texts = resolveTgApiTexts(cfg, lang);
    const sys = TGAPI_SYSTEM_TEXTS[lang];
    if (!flow || flow.state !== "code" || !flow.phone || !flow.randomHash) {
      // 会话状态丢失（memory 会话后端在进程重启后清空，与原 GLOBAL_USERS_DICTIONARY 同源）：
      // 明确告知重新开始，绝不静默吞掉
      ctx.session.tgapi = { ...ctx.session.tgapi, state: "phone" };
      await ctx.reply(sys.sessionLost);
      return;
    }
    // 原实现：先回复进度消息（recieved code. Scarpping web page ...），后续全部 edit
    const progress = await ctx.reply(texts.beforeSuccLogin);
    const editProgress = async (text: string, parseHtml: boolean): Promise<void> => {
      await ctx.api.editMessageText(ctx.chat!.id, progress.message_id, text, {
        ...(parseHtml ? { parse_mode: "HTML" } : {}),
        link_preview_options: { is_disabled: true },
      });
    };

    const providedCode = extractTgWebLoginCode(messageText);
    // v2.1.8：记录消息来源（是否转发）与提取结果，验证「直接转发服务通知消息可正确提取验证码」
    console.log(
      `TGAPI bot #${botId} login code message received: user ${from.id} forwarded=${ctx.message?.forward_origin ? "yes" : "no"} extracted=${providedCode ? "yes" : "no"}`,
    );
    if (!providedCode) {
      // 原实现：IN_VALID_CODE_PVDED 并回退 INPUT_PHONE_NUMBER（要求重新输手机号）
      await editProgress(texts.invalidCode, true);
      ctx.session.tgapi = { ...ctx.session.tgapi, state: "phone" };
      return;
    }

    try {
      const login = await loginStepGetStelCookie(flow.phone, flow.randomHash, providedCode);
      if (!login.ok) {
        // 原实现：把 my.telegram.org 的错误原文原样 edit 给用户，会话结束
        await editProgress(login.error || texts.erredPage, false);
        ctx.session.tgapi = undefined;
        console.log(
          `TGAPI bot #${botId} my.telegram.org login rejected: user ${from.id} reason=${login.error.slice(0, 120)}`,
        );
        return;
      }

      // 申请人自定义 APP 参数（/skip 或未开启自定义时回落管理端默认值）；
      // shortname 由 title 派生（my.telegram.org 要求字母开头 5-32 位）
      const effectiveTitle = flow.appTitle?.trim() || cfg.appTitle;
      const effectiveDescription = flow.appDescription?.trim() || cfg.appDescription;
      const effectiveShortName = deriveTgApiShortName(effectiveTitle, cfg.appShortName);

      // 原实现：抓取现有 APP → 无则按参数创建 → 再抓取（stars have failed us 兜底）
      let scraped: TgOrgScrapeResult | null = null;
      try {
        scraped = await scrapeTgExistingApp(login.cookie);
      } catch (error) {
        console.error(`TGAPI bot #${botId} first /apps scrape failed: user ${from.id}:`, error);
      }
      if (scraped && !scraped.ok && scraped.appHash) {
        try {
          await createNewTgApp({
            stelToken: login.cookie,
            tgAppHash: scraped.appHash,
            appTitle: effectiveTitle,
            appShortName: effectiveShortName,
            appUrl: cfg.appUrl,
            appPlatforms: cfg.appPlatforms,
            appDescription: effectiveDescription,
          });
          console.log(
            `TGAPI bot #${botId} app created: user ${from.id} title="${effectiveTitle}" shortname=${effectiveShortName}`,
          );
        } catch (error) {
          console.error(`TGAPI bot #${botId} /apps/create failed: user ${from.id}:`, error);
        }
        try {
          scraped = await scrapeTgExistingApp(login.cookie);
        } catch (error) {
          scraped = null;
          console.error(`TGAPI bot #${botId} second /apps scrape failed: user ${from.id}:`, error);
        }
      }

      if (scraped?.ok && scraped.info) {
        // v2.1.10：footer 留空 = 不附加任何署名（不再默认拼接原项目作者推广文案）
        const resultHtml =
          buildAppResultHTML(flow.phone, scraped.info) +
          (cfg.footerText ? `\n\n${cfg.footerText}` : "");
        await editProgress(resultHtml, true);
        console.log(
          `TGAPI bot #${botId} app credentials delivered: user ${from.id} app_id=${scraped.info.appId}`,
        );
      } else {
        await editProgress(texts.erredPage, false);
      }
    } catch (error) {
      console.error(`TGAPI bot #${botId} login/scrape pipeline failed: user ${from.id}:`, error);
      await editProgress(
        `${sys.pipelineFail(briefError(error))}\n\n${texts.erredPage}`,
        false,
      );
    }
    // 原实现：ConversationHandler.END（无论成败，登录码状态一律终结；
    // 解锁状态不受影响 —— 同一用户后续再次申请无需再次解锁）
    ctx.session.tgapi = undefined;
  }

  // ---------------------------------------------------------------------------
  // 私聊统一入口（TGAPI 机器人是纯私聊工具机器人；群聊消息一律透传/忽略）
  // ---------------------------------------------------------------------------

  async function handlePrivateMessage(
    ctx: BotContext,
    messageText: string | null,
    contactPhone: string | null,
  ): Promise<void> {
    const from = ctx.from;
    if (!from || from.is_bot) return;
    const lang = langOf(ctx);
    const flow = ctx.session.tgapi;

    // APP 名称/描述状态：任意文本即输入（/start 由指令中间件先行消费并重入，
    // /skip 用管理端默认值推进到下一步）
    if (flow?.state === "title" || flow?.state === "desc") {
      const texts = resolveTgApiTexts(cfg, lang);
      const sys = TGAPI_SYSTEM_TEXTS[lang];
      const input = (messageText ?? "").trim();
      if (flow.state === "title") {
        if (input === "/skip") {
          await advanceToDescription(ctx, lang);
          return;
        }
        if (!input || input.length > APP_TITLE_MAX_LENGTH) {
          await ctx.reply(sys.titleInvalid);
          await ctx.reply(
            renderTgApiTextTemplate(texts.askAppTitle, cfg.appTitle),
            { parse_mode: "HTML" },
          );
          return;
        }
        ctx.session.tgapi = { ...flow, appTitle: input };
        await advanceToDescription(ctx, lang);
        return;
      }
      if (input === "/skip") {
        await advanceToPhone(ctx, lang);
        return;
      }
      if (!input || input.length > APP_DESCRIPTION_MAX_LENGTH) {
        await ctx.reply(sys.descriptionInvalid);
        await ctx.reply(
          renderTgApiTextTemplate(texts.askAppDescription, cfg.appDescription),
          { parse_mode: "HTML" },
        );
        return;
      }
      ctx.session.tgapi = { ...flow, appDescription: input };
      await advanceToPhone(ctx, lang);
      return;
    }

    if (messageText && messageText.startsWith("/")) {
      // 命令交给 command 中间件（/start 重入语义与原 fallback 一致）
      return;
    }

    const unlocked = await getTgApiUnlock(botId, BigInt(from.id));
    if (!unlocked) {
      // 门禁：未解锁时消费全部私聊消息（首次对话必须解锁）
      const texts = resolveTgApiTexts(cfg, lang);
      const sys = TGAPI_SYSTEM_TEXTS[lang];
      if (cfg.unlockMode === "captcha") {
        if (messageText) {
          // 回复解锁提示的消息已由 stateless-question 中间件先行消费；
          // 此处兜底任意文本直接进入核验（与加群验证私聊输码同款宽松通道）
          await handleUnlockAttempt(ctx, lang, messageText.trim());
        } else {
          // v2.1.14：需要用户在输入框输入的交互，先发输入提示再发 force-reply 提问
          await ctx.reply(sys.inputHint);
          await unlockQuestion.replyWithHTML(ctx, htmlEscape(texts.unlockPrompt));
        }
        return;
      }
      if (!ctx.session.tgapiStarsInvoiceSent) {
        await sendStarsInvoice(ctx, lang);
        await ctx.reply(sys.starsInvoiceHint(String(cfg.starsAmount ?? "-")));
      } else {
        await ctx.reply(sys.starsInvoicePending);
      }
      return;
    }
    if (!flow?.state) {
      // 原 ConversationHandler：无状态时的输入被忽略；
      // 这里给出明确重入（等价 /start 的 fallback 语义，避免机器人看起来"没反应"）
      await beginApplication(ctx, lang);
      return;
    }
    if (flow.state === "phone") {
      await handlePhoneInput(ctx, lang, messageText, contactPhone);
      return;
    }
    if (flow.state === "code" && messageText) {
      await handleCodeInput(ctx, lang, messageText);
    }
  }

  // ---------------------------------------------------------------------------
  // 中间件装配（顺序：问题插件 → 指令 → 授权认证 callback → 自定义指令 → 文本 → 支付）
  // ---------------------------------------------------------------------------

  bot.use(unlockQuestion.middleware());

  // /start：私聊 = 完整对话入口；群组 = 同样响应欢迎消息（v2.1.10 修复
  // 图5「群里 /start@机器人没反应」）。grammY 原生支持定向指令：
  // 群内 /start@本机器人 才匹配，/start@其他机器人 不响应。
  bot.command("start", async (ctx) => {
    const chatType = ctx.chat?.type;
    if (chatType === "private") {
      await startConversation(ctx);
      return;
    }
    if (chatType === "group" || chatType === "supergroup") {
      await sendUnlockEntry(ctx, langOf(ctx));
    }
  });

  // /language：中英文切换（zh/中文/chinese → 中文；en/英文/english → 英文；
  // 无参数在两种语言间切换；会话内记忆，新会话按用户 language_code 自动识别）
  async function switchLanguage(ctx: BotContext): Promise<void> {
    const from = ctx.from;
    if (!from || from.is_bot) return;
    // bot.command(string) 的 match 恒为 string；RegExpMatchArray 分支仅类型层存在
    const arg = (typeof ctx.match === "string" ? ctx.match : "").trim().toLowerCase();
    let next: TgApiLang | null = null;
    if (arg === "zh" || arg === "中文" || arg === "chinese" || arg === "cn") next = "zh";
    else if (arg === "en" || arg === "英文" || arg === "english") next = "en";
    else if (!arg) next = langOf(ctx) === "zh" ? "en" : "zh";
    if (!next) {
      await ctx.reply(TGAPI_SYSTEM_TEXTS[langOf(ctx)].languageInvalid);
      return;
    }
    ctx.session.tgapiLang = next;
    await ctx.reply(TGAPI_SYSTEM_TEXTS[next].languageHelp(next));
    console.log(
      `TGAPI bot #${botId} language switched: user ${from.id} -> ${next}`,
    );
  }

  bot.command("language", async (ctx) => {
    if (ctx.chat?.type !== "private") return;
    await switchLanguage(ctx);
  });

  // 「🔐 授权认证」内嵌按钮：私聊 force-reply 要求在输入框输入验证码；
  // 群组引导私聊完成（验证码绝不在群里输入，避免泄露给群成员）
  bot.callbackQuery(TGAPI_UNLOCK_CALLBACK, async (ctx) => {
    const lang = langOf(ctx);
    const texts = resolveTgApiTexts(cfg, lang);
    const sys = TGAPI_SYSTEM_TEXTS[lang];
    const from = ctx.from;
    const chatType = ctx.chat?.type;
    // 已解锁用户点历史按钮：不重复核验（解锁一次永久有效）
    if (from && !from.is_bot && (await getTgApiUnlock(botId, BigInt(from.id)))) {
      await ctx.answerCallbackQuery({
        text: lang === "zh" ? "已完成授权认证" : "Already authorized",
      });
      if (chatType === "private") await beginApplication(ctx, lang);
      return;
    }
    await ctx.answerCallbackQuery();
    if (chatType === "private") {
      if (cfg.unlockMode === "captcha") {
        // 点击后发送消息要求在输入框输入验证码（StatelessQuestion force-reply）；
        // v2.1.14：先发输入提示再发提问，引导用户去输入框输入
        await ctx.reply(sys.inputHint);
        await unlockQuestion.replyWithHTML(ctx, htmlEscape(texts.unlockPrompt));
      } else {
        await sendStarsInvoice(ctx, lang);
        await ctx.reply(sys.starsInvoiceHint(String(cfg.starsAmount ?? "-")));
      }
      return;
    }
    if (chatType !== "group" && chatType !== "supergroup") return;
    const username = bot.isInited() ? bot.botInfo.username : (await bot.api.getMe()).username;
    await ctx.reply(
      lang === "zh"
        ? "🔐 授权认证需要在私聊中完成：点击下方按钮打开与我的私聊，发送 /start 开始。"
        : "🔐 Authorization must be completed in a private chat: tap the button below to open a chat with me, then send /start.",
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: lang === "zh" ? "🔐 私聊我完成授权认证" : "🔐 Authorize in private chat",
                url: `https://t.me/${username}`,
              },
            ],
          ],
        } satisfies InlineKeyboardMarkup,
      },
    );
    console.log(
      `TGAPI bot #${botId} unlock button clicked in ${chatType}: user ${from?.id ?? "?"} -> DM guidance`,
    );
  });

  // ---------------------------------------------------------------------------
  // 指令注册（唯一来源：机器人管理页「⌨️ 指令菜单」弹窗勾选，bots.config.commandIds）
  // ---------------------------------------------------------------------------
  // 管理员在「指令菜单」弹窗勾选并保存后，实例经 restartMenuBot 热更新按勾选注册；
  // 运行时绝不按指令库启用状态自行补注册 —— 未勾选的指令一律不响应。TGAPI 自有
  // 指令 /start /language（流程重入/语言切换）不依赖勾选，始终可用。
  const selectedIds = options.commandIds
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)
    .map((id) => BigInt(id));
  // 指令归属过滤（v2.1.13）：机器人私有指令仅本 TGAPI 机器人可注册；
  // 群组私有指令注册是机器人级，群组限制由 runner 校验（scopeCommandRunnerToGroup）
  const selectedItems =
    selectedIds.length > 0
      ? await listBotCommandsByIds(selectedIds, { botId })
      : [];

  // 内置指令：仅注册勾选项（排除 /start —— TGAPI 流程自有重入语义，避免双响应）。
  // registerBuiltinCommandHandlers 同步填充菜单「执行指令」按钮注册表（真实处理器，
  // adminOnly 闭包自校验防越权）并注册 bot.command（手输 /指令 同源）。
  const selectedBuiltin = selectedItems
    .filter((item) => item.type === "builtin" && item.name !== "start")
    .map((item) => ({ name: item.name, intro: item.intro, description: item.description }));
  registerBuiltinCommandHandlers(bot, selectedBuiltin, registry);

  // 自定义指令：仅注册勾选启用项 ——
  // 1) /xxx 手输响应（CommandGroup，宽松匹配 + 定向指令支持，群内 /xxx@本机器人 同样可用）；
  // 2) 填充菜单「执行指令」按钮注册表 —— 按钮点击与手输 /指令 完全同源
  const customItems = selectedItems.filter((item) => item.type === "custom");
  for (const item of customItems) {
    const intro = item.intro || item.description;
    const commandName = item.name;
    // v2.1.13 群组私有指令：非绑定群组内不执行（含菜单按钮点击同一运行器）
    const runner: MenuCommandRunner = scopeCommandRunnerToGroup(
      item.groupId,
      commandName,
      async (ctx) => {
        await ctx.reply(`⌨️ /${commandName}\n\n${intro}`);
      },
    );
    registry.runners.set(commandName, runner);
  }
  if (customItems.length > 0) {
    const group = new CommandGroup({
      matchOnlyAtStart: false,
      targetedCommands: "optional",
    });
    for (const item of customItems) {
      const commandName = item.name;
      group.command(commandName, item.description, async (ctx) => {
        const runner = registry.runners.get(commandName);
        if (runner) {
          await runner(ctx);
          return;
        }
        await ctx.reply(`⌨️ /${commandName}\n\n${item.intro || item.description}`);
      });
    }
    bot.use(group);
  }
  console.log(
    `TGAPI bot #${botId} commands registered (menu selection only): builtin=[${selectedBuiltin.map((item) => item.name).join(", ") || "none"}] custom=[${customItems.map((item) => item.name).join(", ") || "none"}]`,
  );

  // 菜单「执行指令」按钮注册表：TGAPI 机器人自有指令（/start /language）同源可点。
  // 运行器签名是 Context（菜单插件回调上下文）；会话中间件先于菜单安装，
  // 运行时 ctx 必然携带 session —— 与 CommandGroup 处理器同一事实，此处窄化。
  registry.runners.set("start", async (ctx) => {
    const chatType = ctx.chat?.type;
    if (chatType === "private") {
      await startConversation(ctx as BotContext);
      return;
    }
    if (chatType === "group" || chatType === "supergroup") {
      await sendUnlockEntry(ctx as BotContext, langOf(ctx as BotContext));
    }
  });
  registry.runners.set("language", async (ctx) => {
    if (ctx.chat?.type !== "private") {
      await ctx.reply("⚠️ 该指令请在与机器人的私聊中使用。");
      return;
    }
    await switchLanguage(ctx as BotContext);
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.chat?.type !== "private") return;
    await handlePrivateMessage(ctx, ctx.message.text, null);
  });

  bot.on("message:contact", async (ctx) => {
    if (ctx.chat?.type !== "private") return;
    await handlePrivateMessage(
      ctx,
      ctx.message.text ?? null,
      ctx.message.contact.phone_number || null,
    );
  });

  // Telegram Stars 支付链路：预结单放行 + 支付成功落库解锁
  bot.on("pre_checkout_query", async (ctx) => {
    const payload = ctx.preCheckoutQuery.invoice_payload;
    if (!payload.startsWith(UNLOCK_PAYLOAD_PREFIX)) {
      await ctx.answerPreCheckoutQuery(false, { error_message: "无效的支付请求" });
      return;
    }
    await ctx.answerPreCheckoutQuery(true);
  });

  bot.on("message:successful_payment", async (ctx) => {
    if (ctx.chat?.type !== "private") return;
    const from = ctx.from;
    const payment = ctx.message.successful_payment;
    if (!from || from.is_bot || !payment) return;
    if (!payment.invoice_payload.startsWith(UNLOCK_PAYLOAD_PREFIX)) return;
    const lang = langOf(ctx);
    await saveTgApiUnlock({
      botId,
      userId: BigInt(from.id),
      username: from.username ?? null,
      mode: "stars",
    });
    ctx.session.tgapiStarsInvoiceSent = false;
    // v2.1.10：支付成功同款 —— 验证成功消息 + 图4 菜单内嵌按钮
    await sendUnlockSuccessWithMenu(ctx, lang);
    console.log(
      `TGAPI bot #${botId} unlocked via stars: user ${from.id} paid ${payment.total_amount} XTR (${payment.telegram_payment_charge_id})`,
    );
  });

  // 指令同步：/start + /language（TGAPI 自有）+「⌨️ 指令菜单」弹窗勾选的内置
  //（不含 /start）与自定义指令（真实写入 Telegram 指令菜单；Telegram 上限 100 条，
  // 超出部分按顺序截断）—— 与注册同源，未勾选的指令不进 Telegram 指令菜单。
  const fixedCommandCount = 2 + selectedBuiltin.length;
  const myCommands = [
    { command: "start", description: "开始 TGAPI 申请 / Start" },
    { command: "language", description: "切换中文/English" },
    ...selectedBuiltin.map((item) => ({
      command: item.name,
      description: (item.description || item.intro || item.name).slice(0, 256),
    })),
    ...customItems.slice(0, Math.max(0, 100 - fixedCommandCount)).map((item) => ({
      command: item.name,
      description: (item.description || item.intro || item.name).slice(0, 256),
    })),
  ];
  return async () => {
    await bot.api.setMyCommands(myCommands).catch((error: unknown) => {
      console.warn(`TGAPI bot #${botId} setMyCommands failed:`, error);
    });
  };
}
