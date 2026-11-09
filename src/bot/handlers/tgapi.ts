import { Bot } from "grammy";
import type { MessageEntity } from "grammy/types";
import { StatelessQuestion } from "@grammyjs/stateless-question";
import type { BotContext } from "../context";
import { htmlEscape } from "@/utils/html";
import {
  getTgApiUnlock,
  getVerificationMethod,
  saveTgApiUnlock,
} from "@/database/operations";
import {
  parseCodeApiConfig,
  verifyCodeExternally,
} from "@/services/external-verify";
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

/**
 * TGAPI申请 机器人（v2.1.7）—— grammY 原样复刻 SpEcHiDe/MyTelegramOrgRoBot。
 *
 * 原项目：python-telegram-bot ConversationHandler（/start → INPUT_PHONE_NUMBER →
 * INPUT_TG_CODE）+ my.telegram.org 抓取。本实现 1:1 移植状态机与文案：
 *
 * /start ──▶ START_TEXT（等待手机号，INPUT_PHONE_NUMBER）
 * 手机号 ──▶ POST /auth/send_password → random_hash（GLOBAL_USERS_DICTIONARY 落会话）
 *         ──▶ AFTER_RECVD_CODE_TEXT（等待 Telegram 登录码，INPUT_TG_CODE）
 * 登录码 ──▶ POST /auth/login → stel_token Cookie ──▶ GET /apps 抓取
 *         ├─ 已有 APP → 解析 app_id/api_hash/MTProto 服务器 → 结果消息
 *         └─ 无 APP   → POST /apps/create（APP 参数）→ 重新抓取 → 结果消息
 * /start 在任意阶段重入（fallback 语义一致）。
 *
 * v2.1.7 变更：
 * - 中英文双语（仅 zh/en 两套内置文案）：按用户 language_code 自动识别（zh* → 中文），
 *   /language 指令手动切换（会话内记忆）。
 * - 申请人自定义 APP（askAppDetails 开启时）：/start → APP 名称（/skip 用默认）
 *   → APP 描述（/skip 用默认）→ 手机号 → 登录码；创建 APP 使用申请人提交的
 *   title/description（shortname 由 title 派生，不合法回落配置默认）。
 * - 解锁一次永久有效：解锁状态落库 tgapi_unlocks（bot_id + user_id 唯一），
 *   生成失败/重复申请均不再要求重新解锁（管理端手动「撤销解锁」除外）。
 *
 * v2.1.6 增值门禁（原项目没有）：首次对话需要解锁 ——
 * - captcha：回复解锁提示输入验证码，走外部 API 核验（与加群验证机器人
 *   code_api 外部 API 验证方式同一实现 verifyCodeExternally）；
 * - stars：Telegram 星星支付发票（sendInvoice XTR），支付成功即解锁。
 */

/** 星星支付发票 payload 前缀 */
const UNLOCK_PAYLOAD_PREFIX = "tgapi_unlock:";

/** 解锁无状态问题 id（每个 TGAPI 机器人实例独立安装，互不串扰） */
const TGAPI_UNLOCK_QUESTION_ID = "tgapi-unlock";

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
 * 返回指令同步任务（/start + /language 两条指令；TGAPI 机器人不挂指令库/
 * 群验证/AI 客服，是纯私聊对话工具机器人）。
 */
export function registerTgApiHandlers(
  bot: Bot<BotContext>,
  cfg: TgApiBotConfig,
  botId: bigint,
): () => Promise<void> {
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
    const texts = resolveTgApiTexts(cfg, lang);
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
    await ctx.reply(texts.unlockSuccess);
    await beginApplication(ctx, lang);
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
   * 开始申请流程（已解锁用户）：askAppDetails 开启时先收集 APP 名称/描述
   * （申请人自定义，/skip 用管理端默认），否则直接进入手机号状态（原版行为）。
   */
  async function beginApplication(ctx: BotContext, lang: TgApiLang): Promise<void> {
    const texts = resolveTgApiTexts(cfg, lang);
    ctx.session.tgapi = cfg.askAppDetails ? { state: "title" } : { state: "phone" };
    await ctx.reply(texts.start, { parse_mode: "HTML" });
    if (cfg.askAppDetails) {
      await ctx.reply(
        renderTgApiTextTemplate(texts.askAppTitle, cfg.appTitle),
        { parse_mode: "HTML" },
      );
    }
  }

  /** /start 入口（对应原 ConversationHandler entry_point + fallback） */
  async function startConversation(ctx: BotContext): Promise<void> {
    const from = ctx.from;
    if (!from || from.is_bot) return;
    const lang = langOf(ctx);
    const texts = resolveTgApiTexts(cfg, lang);
    const sys = TGAPI_SYSTEM_TEXTS[lang];
    const unlocked = await getTgApiUnlock(botId, BigInt(from.id));
    if (unlocked) {
      await beginApplication(ctx, lang);
      return;
    }
    // 首次对话门禁：未解锁用户先解锁（验证码 / 星星两种方式，管理后台可切换）
    if (cfg.unlockMode === "captcha") {
      await unlockQuestion.replyWithHTML(ctx, htmlEscape(texts.unlockPrompt));
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
        const resultHtml =
          buildAppResultHTML(flow.phone, scraped.info) + "\n\n" + cfg.footerText;
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
  // 中间件装配（顺序与 multi-runtime 通用链一致：问题插件 → 指令 → 文本 → 支付）
  // ---------------------------------------------------------------------------

  bot.use(unlockQuestion.middleware());

  bot.command("start", async (ctx) => {
    if (ctx.chat?.type !== "private") return;
    await startConversation(ctx);
  });

  // /language：中英文切换（zh/中文/chinese → 中文；en/英文/english → 英文；
  // 无参数在两种语言间切换；会话内记忆，新会话按用户 language_code 自动识别）
  bot.command("language", async (ctx) => {
    if (ctx.chat?.type !== "private") return;
    const from = ctx.from;
    if (!from || from.is_bot) return;
    const arg = (ctx.match ?? "").trim().toLowerCase();
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
    const texts = resolveTgApiTexts(cfg, lang);
    await saveTgApiUnlock({
      botId,
      userId: BigInt(from.id),
      username: from.username ?? null,
      mode: "stars",
    });
    ctx.session.tgapiStarsInvoiceSent = false;
    await ctx.reply(texts.unlockSuccess);
    await beginApplication(ctx, lang);
    console.log(
      `TGAPI bot #${botId} unlocked via stars: user ${from.id} paid ${payment.total_amount} XTR (${payment.telegram_payment_charge_id})`,
    );
  });

  // 指令同步：/start（开始申请）+ /language（中英文切换）
  return async () => {
    await bot.api
      .setMyCommands([
        { command: "start", description: "开始 TGAPI 申请 / Start" },
        { command: "language", description: "切换中文/English" },
      ])
      .catch((error: unknown) => {
        console.warn(`TGAPI bot #${botId} setMyCommands failed:`, error);
      });
  };
}
