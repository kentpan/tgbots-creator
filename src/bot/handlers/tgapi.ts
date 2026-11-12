import { Bot } from "grammy";
import type { InlineKeyboardMarkup, MessageEntity } from "grammy/types";
import { CommandGroup } from "@grammyjs/commands";
import { StatelessQuestion } from "@grammyjs/stateless-question";
import type { BotContext } from "../context";
import { htmlEscape } from "@/utils/html";
import {
  getTgApiBotUser,
  getTgApiUnlock,
  listBotCommandsByIds,
  saveTgApiBotUser,
} from "@/database/operations";
import { approveTelegramJoinRequest } from "@/services/approval";
import {
  countMenuStats,
  isValidTgApiPlatformValue,
  renderMenuMarkup,
  renderMenuTemplate,
  scopeCommandRunnerToGroup,
  TGAPI_PLATFORM_LABELS,
  varsFromContext,
  type MenuCommandRegistry,
  type MenuCommandRunner,
  type MenuTgApiResponse,
} from "@/services/bot-menu";
import type { BotMenuConfig } from "@/services/bot-menu";
import {
  deriveTgApiShortName,
  detectTgApiLang,
  renderTgApiTextTemplate,
  resolveTgApiTexts,
  tgApiInterfaceMode,
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
import { registerBuiltinCommandHandlers } from "./builtin-commands";
import { registerTgApiConversation } from "./tgapi-conversation";
import {
  checkTgApiGateMethod,
  createTgApiGateRouter,
  persistTgApiUnlock,
  sendTgApiStarsInvoice,
  verifyTgApiUnlockCode,
} from "../tgapi-gate";

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

/**
 * TGAPI 内置功能动态按钮 callback 前缀（v2.1.16）：非菜单消息上的功能按钮
 *（如「已创建 → 💎 我的API」提示消息）使用原生 callback_data，
 * 与 @grammyjs/menu 的菜单按钮（data 含 "/" 分段）互不串扰。
 */
const TGAPI_FUNC_CALLBACK_PREFIX = "tgapi_func:";

/** 申请人自定义 APP 名称/描述的长度上限（my.telegram.org 表单约束） */
const APP_TITLE_MAX_LENGTH = 32;
const APP_DESCRIPTION_MAX_LENGTH = 200;

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
 * 返回指令同步任务（「⌨️ 指令菜单」弹窗勾选指令同步到 Telegram 指令菜单）。
 *
 * v2.1.14 指令来源彻底收敛（不再有任何硬编码注册的「TGAPI 自有指令」）：
 * - /start：唯一启动指令，但必须自行配置 —— 仅当管理员在「⌨️ 指令菜单」弹窗勾选
 *   指令库 /start 条目（bots.config.commandIds 包含其 id）时才注册响应（执行
 *   TGAPI 启动语义而非通用欢迎指令）；未勾选 = 不注册、不响应；
 * - 语言切换：不再是 /language 指令 —— 管理端在「消息内嵌按钮」配置
 *   「语言切换」按钮（action.type=language，菜单设计器 TGAPI 机器人专属选项），
 *   点击后在 中文/English 间切换并回复确认。
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
  // 指令注册来源（唯一：机器人管理页「⌨️ 指令菜单」弹窗勾选，bots.config.commandIds）
  // —— 内嵌按钮模式与自定义键盘对话模式共用同一份勾选与同步任务
  // ---------------------------------------------------------------------------
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
  // 指令同步（v2.1.14）：仅勾选的指令写入 Telegram 指令菜单
  //（Telegram 上限 100 条，超出部分按顺序截断）；描述与 syncBotCommandsToTelegram
  // 同一规则（指令库条目 description > intro > 名称）。
  const myCommands = selectedItems.slice(0, 100).map((item) => ({
    command: item.name,
    description: (item.description || item.intro || item.name).slice(0, 256),
  }));
  const syncCommands = async (): Promise<void> => {
    await bot.api.setMyCommands(myCommands).catch((error: unknown) => {
      console.warn(`TGAPI bot #${botId} setMyCommands failed:`, error);
    });
  };

  // ---------------------------------------------------------------------------
  // v2.2.0 自定义键盘对话流程（与消息内嵌按钮互斥）；v2.2.6 生效模式解耦：
  // interfaceMode（checkbox 单选，保存并部署后生效）决定渲染哪种界面，
  // customKeyboard 仅是可附加属性 —— 配置保留不清除，切回内嵌模式不丢配置。
  // 旧数据无 interfaceMode 时 tgApiInterfaceMode 按原语义（customKeyboard 非空）推断。
  // 生效条件 = 键盘模式 && 键盘配置非空（空键盘回落内嵌按钮）。
  // ---------------------------------------------------------------------------
  if (tgApiInterfaceMode(cfg) === "keyboard" && cfg.customKeyboard) {
    registerTgApiConversation(bot, { cfg, botId, keyboard: cfg.customKeyboard });
    // 加群申请自动通过（与内嵌模式同一能力，对话模式下仍需生效）
    bot.on("chat_join_request", async (ctx) => {
      const joinRequest = ctx.chatJoinRequest;
      if (!joinRequest) return;
      const { from: requestUser, chat } = joinRequest;
      const approval = await approveTelegramJoinRequest(BigInt(chat.id), BigInt(requestUser.id), ctx.api);
      console.log(
        `TGAPI bot #${botId} join request: user ${requestUser.id} ` +
          `to chat ${chat.id} -> ${approval.success ? "auto-approved" : `failed: ${approval.error ?? "unknown"}`}`,
      );
    });
    console.log(
      `TGAPI bot #${botId} custom keyboard mode active (inline menu suppressed by mutual exclusion)`,
    );
    return syncCommands;
  }

  // ---------------------------------------------------------------------------
  // 解锁门禁：外部 API 验证码（stateless-question force_reply，与加群验证同款交互）
  // 核验/落库统一走 tgapi-gate.ts 通用门禁组件（真实外部 API 核验 + 落库回读）
  // ---------------------------------------------------------------------------
  const gateDeps = { cfg, botId };

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

  /** 外部 API 核验解锁码（通用门禁组件共享实现：真实外部 API 核验 + 落库回读） */
  async function handleUnlockAttempt(ctx: BotContext, lang: TgApiLang, code: string): Promise<void> {
    const from = ctx.from;
    if (!from) return;
    const sys = TGAPI_SYSTEM_TEXTS[lang];
    if (cfg.unlockMode !== "captcha") {
      await ctx.reply(sys.switchedToStars);
      return;
    }
    const check = await checkTgApiGateMethod(gateDeps);
    if (check.kind === "method-missing") {
      await ctx.reply(sys.methodMissing);
      return;
    }
    if (check.kind === "method-unavailable") {
      await ctx.reply(sys.methodUnavailable);
      return;
    }
    if (check.kind === "method-config-invalid") {
      await ctx.reply(sys.methodConfigInvalid);
      return;
    }
    const result = await verifyTgApiUnlockCode(
      gateDeps,
      check.apiConfig,
      { userId: BigInt(from.id), username: from.username ?? null, code },
      {
        onNetworkRetry: async () => {
          await ctx.reply(sys.networkRetry);
        },
      },
    );
    if (!result.ok) {
      // 网络故障不计入用户侧任何代价，明确说明并附带具体原因便于管理员排查
      await ctx.reply(
        result.networkError
          ? `${result.message}${result.detail ? `\n原因：${result.detail}` : ""}\n${sys.unlockNetworkRetry}`
          : result.message,
      );
      return;
    }
    const persisted = await persistTgApiUnlock(
      gateDeps,
      BigInt(from.id),
      from.username ?? null,
      "captcha",
    );
    if (!persisted) {
      await ctx.reply(sys.unlockPersistFail);
      return;
    }
    ctx.session.tgapiStarsInvoiceSent = false;
    // 解锁通过 → 直接进入下一步（单条手机号提示；不再发送单独成功消息）
    await beginApplication(ctx, lang);
    console.log(
      `TGAPI bot #${botId} unlocked via captcha: user ${from.id} (${from.username ?? "no username"})`,
    );
  }

  /** 发送星星解锁发票（通用门禁组件共享实现；金额未配置绝不放行） */
  async function sendStarsInvoice(ctx: BotContext, lang: TgApiLang): Promise<void> {
    if (!ctx.chat) return;
    const sys = TGAPI_SYSTEM_TEXTS[lang];
    const sent = await sendTgApiStarsInvoice(gateDeps, ctx.api, ctx.chat.id);
    if (sent === "not-configured") {
      await ctx.reply(sys.starsNotConfigured);
      return;
    }
    ctx.session.tgapiStarsInvoiceSent = true;
    await ctx.reply(sys.starsInvoiceHint(String(cfg.starsAmount ?? "-")));
  }

  /**
   * /start 欢迎消息（未解锁用户）：图3 文案 + 底部内嵌按钮「🔐 授权认证」。
   * 私聊与群组共用；群组点击按钮由 callback 处理器引导私聊完成。
   * v2.1.16：/start 主路径已升级为 sendTgApiStartMessage（初始消息+管理端内嵌按钮），
   * 本函数保留用于旧消息上的历史按钮与未配置任何按钮时的回落入口。
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

  // ---------------------------------------------------------------------------
  // v2.1.16 TGAPI 内置功能（需求2/4/5/8/9）：初始消息 / 创建API / 我的API
  // ---------------------------------------------------------------------------

  /** 按语言取按钮响应文案（tgapi_response：优先用户语言，为空回落另一语言） */
  function responseText(response: MenuTgApiResponse | undefined, lang: TgApiLang): string {
    if (!response) return "";
    const primary = (lang === "zh" ? response.zh : response.en).trim();
    if (primary) return primary;
    return (lang === "zh" ? response.en : response.zh).trim();
  }

  /**
   * /start 初始消息（v2.1.16 需求4，图1）：双语欢迎文案 + 管理端「内嵌按钮配置」
   * 真实渲染的菜单键盘。每次 /start 重新发送一条新的初始消息+内嵌按钮，之前的消息
   * 和内嵌按钮过时失效 —— 发送前先把台账记录的旧消息键盘移除
   *（editMessageReplyMarkup 置空；消息已删/超 Telegram 48h 编辑窗口时失败被忽略，
   * 由 multi-runtime 的菜单按钮过期拦截中间件兜底提示）。管理端未配置任何按钮时
   * 回落「🔐 授权认证」单按钮（保持旧版门禁入口可用，绝不出现无按钮死路）。
   */
  async function sendTgApiStartMessage(ctx: BotContext, lang: TgApiLang): Promise<void> {
    const from = ctx.from;
    if (!from || from.is_bot || !ctx.chat) return;
    const texts = resolveTgApiTexts(cfg, lang);
    const botUser = await getTgApiBotUser(botId, BigInt(from.id));
    // 旧消息过时失效：移除旧键盘（失败场景由 callback 过期拦截兜底）
    if (botUser?.menuMessageId) {
      await ctx.api
        .editMessageReplyMarkup(ctx.chat.id, botUser.menuMessageId, {
          reply_markup: { inline_keyboard: [] },
        })
        .catch((error: unknown) => {
          console.log(
            `TGAPI bot #${botId} outdated keyboard removal skipped: user ${from.id} ` +
              `message ${botUser.menuMessageId}: ${briefError(error)}`,
          );
        });
    }
    let markup: InlineKeyboardMarkup;
    if (countMenuStats(menuConfig.root).buttons > 0) {
      markup = await renderMenuMarkup(menuConfig, bot, registry);
    } else {
      markup = {
        inline_keyboard: [[{ text: "🔐 授权认证", callback_data: TGAPI_UNLOCK_CALLBACK }]],
      };
    }
    const sent = await ctx.reply(texts.start, { parse_mode: "HTML", reply_markup: markup });
    // 台账记录最新菜单消息 id（下一轮 /start 移除旧键盘 + 过期拦截共同依赖）
    await saveTgApiBotUser({
      botId,
      userId: BigInt(from.id),
      username: from.username ?? undefined,
      menuMessageId: sent.message_id,
    });
    console.log(
      `TGAPI bot #${botId} start message sent: user ${from.id} ` +
        `menu_message=${sent.message_id} (old=${botUser?.menuMessageId ?? "none"})`,
    );
  }

  /** 群内点击 TGAPI 功能：引导私聊完成（返回 true = 已引导，调用方结束处理） */
  async function guideTgApiFuncToPrivate(ctx: BotContext, lang: TgApiLang): Promise<boolean> {
    const chatType = ctx.chat?.type;
    if (!chatType) return true;
    if (chatType === "private") return false;
    if (chatType !== "group" && chatType !== "supergroup") return true;
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
        } satisfies InlineKeyboardMarkup,
      },
    );
    console.log(
      `TGAPI bot #${botId} func button clicked in ${chatType}: user ${ctx.from?.id ?? "?"} -> DM guidance`,
    );
    return true;
  }

  /**
   * 创建API功能（v2.1.16 需求5/8/9）：
   * 1. 先检测「我的API」是否已创建过（在解锁门禁之前）：已创建 → 提示点击 💎 我的API 查看；
   * 2. 解锁门禁（按钮配置 tgapi_unlock=true 时）：未解锁 → 验证码验证流程（captcha）
   *    / 星星发票（stars），通过后自动调创建API（handleUnlockAttempt / 支付回调内）；
   * 3. 已解锁 → 直接进入创建流程。解锁一次永久有效：任意按钮通过验证后所有按钮不再需要验证。
   */
  async function runCreateApi(
    ctx: BotContext,
    lang: TgApiLang,
    unlockRequired: boolean,
    templates?: { success?: MenuTgApiResponse; fail?: MenuTgApiResponse },
  ): Promise<void> {
    const from = ctx.from;
    if (!from || from.is_bot) return;
    const texts = resolveTgApiTexts(cfg, lang);
    // 1. 已创建检测（解锁门禁前）
    const botUser = await getTgApiBotUser(botId, BigInt(from.id));
    if (botUser?.appId) {
      await ctx.reply(renderMenuTemplate(texts.alreadyCreated, varsFromContext(ctx)), {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: lang === "zh" ? "💎 我的API" : "💎 My API",
                callback_data: `${TGAPI_FUNC_CALLBACK_PREFIX}my`,
              },
            ],
          ],
        } satisfies InlineKeyboardMarkup,
      });
      return;
    }
    // 2. 解锁门禁（每按钮可选；解锁一次永久有效）—— 唯一门禁提示，不再叠加输入提示
    if (unlockRequired && !(await getTgApiUnlock(botId, BigInt(from.id)))) {
      const sys = TGAPI_SYSTEM_TEXTS[lang];
      if (cfg.unlockMode === "captcha") {
        await unlockQuestion.replyWithHTML(ctx, htmlEscape(texts.unlockPrompt));
      } else {
        await sendStarsInvoice(ctx, lang);
        await ctx.reply(sys.starsInvoiceHint(String(cfg.starsAmount ?? "-")));
      }
      return;
    }
    // 3. 已解锁 → 创建API流程（按钮级结果消息模板随会话带入，登录码流程结束时渲染）
    if (templates?.success) {
      ctx.session.tgapi = { state: "phone", ...ctx.session.tgapi, pendingSuccess: templates.success };
    }
    if (templates?.fail) {
      ctx.session.tgapi = { state: "phone", ...ctx.session.tgapi, pendingFail: templates.fail };
    }
    await beginApplication(ctx, lang);
  }

  /**
   * 我的API功能（v2.1.16 需求5，图2格式）：展示已创建的 api_id / api_hash。
   * 格式逐字对齐图2：📱 号码 / 🆔 api_id / 🔑 api_hash 三行；未创建时给出明确引导。
   * v2.1.16 指令消息槽位：按钮配置 tgapi_success/tgapi_fail 时按模板渲染
   *（{{phone}}/{{api_id}}/{{api_hash}} 变量；留空用内置默认三行格式）。
   */
  async function runMyApi(
    ctx: BotContext,
    lang: TgApiLang,
    templates?: { success?: MenuTgApiResponse; fail?: MenuTgApiResponse },
  ): Promise<void> {
    const from = ctx.from;
    if (!from || from.is_bot) return;
    const botUser = await getTgApiBotUser(botId, BigInt(from.id));
    const templateText = (template: MenuTgApiResponse | undefined): string => {
      const primary = (lang === "zh" ? template?.zh : template?.en)?.trim() ?? "";
      return primary || (lang === "zh" ? template?.en : template?.zh)?.trim() || "";
    };
    if (!botUser?.appId) {
      const failRaw = templates ? templateText(templates.fail) : "";
      await ctx.reply(
        renderMenuTemplate(failRaw || resolveTgApiTexts(cfg, lang).myApiEmpty, varsFromContext(ctx)),
      );
      return;
    }
    const vars = {
      ...varsFromContext(ctx),
      phone: botUser.appPhone ?? "-",
      api_id: botUser.appId,
      api_hash: botUser.appHash ?? "-",
    };
    const successRaw = templates ? templateText(templates.success) : "";
    await ctx.reply(
      renderMenuTemplate(successRaw || resolveTgApiTexts(cfg, lang).myApiResult, vars),
    );
    console.log(
      `TGAPI bot #${botId} my api delivered: user ${from.id} app_id=${botUser.appId}`,
    );
  }

  // v2.1.16：TGAPI 内置功能执行器（菜单按钮 tgapi_func 点击统一入口，bot-menu 渲染层调用）。
  // 按钮级门禁开关与响应文案随 action 透传；响应消息先发（{{变量}} 按真实上下文渲染），
  // 群内点击一律引导私聊完成（创建/查看 API 都是私聊流程）。
  registry.tgapiFuncRunner = async (ctx, { func, unlock, value, response, success, fail }) => {
    const from = ctx.from;
    if (!from || from.is_bot) return;
    const lang = langOf(ctx as BotContext);
    if (await guideTgApiFuncToPrivate(ctx as BotContext, lang)) return;
    const responseRaw = responseText(response, lang);
    if (responseRaw) {
      await ctx.reply(renderMenuTemplate(responseRaw, varsFromContext(ctx)));
    }
    if (func === "start") {
      await sendTgApiStartMessage(ctx as BotContext, lang);
      return;
    }
    if (func === "create") {
      await runCreateApi(ctx as BotContext, lang, unlock, { success, fail });
      return;
    }
    if (func === "my") {
      await runMyApi(ctx as BotContext, lang, { success, fail });
      return;
    }
    // v2.2.0 固定指令全量（设置平台/语言/帮助/客服支持/跳过/设置Title/设置Description）
    if (func === "platform") {
      if (value && isValidTgApiPlatformValue(value)) {
        (ctx as BotContext).session.tgapiPlatform = value;
        const label = TGAPI_PLATFORM_LABELS[value] ?? value;
        const successRaw = responseText(success, lang);
        await ctx.reply(
          renderMenuTemplate(
            successRaw || resolveTgApiTexts(cfg, lang).platformSet,
            {
              ...varsFromContext(ctx),
              platform: label,
            },
          ),
        );
        return;
      }
      await ctx.reply(
        lang === "zh"
          ? "📱 请展开「设置平台」子菜单选择平台（每行 2 个共 8 个平台按钮）；选中平台用于创建 APP 时提交。"
          : "📱 Please open the 📱 Set Platform submenu to pick a platform (8 options, 2 per row).",
      );
      return;
    }
    if (func === "help") {
      await ctx.reply(
        renderMenuTemplate(
          responseRaw || resolveTgApiTexts(cfg, lang).helpText,
          varsFromContext(ctx),
        ),
      );
      return;
    }
    if (func === "support") {
      await ctx.reply(
        renderMenuTemplate(
          responseRaw || resolveTgApiTexts(cfg, lang).supportText,
          varsFromContext(ctx),
        ),
      );
      return;
    }
    if (func === "settitle") {
      if (!responseRaw) {
        const texts = resolveTgApiTexts(cfg, lang);
        await ctx.reply(renderTgApiTextTemplate(texts.askAppTitle, cfg.appTitle), { parse_mode: "HTML" });
      }
      (ctx as BotContext).session.tgapi = { state: "prefTitle" };
      (ctx as BotContext).session.tgapiPendingSlot = { success, fail };
      return;
    }
    if (func === "setdescription") {
      if (!responseRaw) {
        const texts = resolveTgApiTexts(cfg, lang);
        await ctx.reply(renderTgApiTextTemplate(texts.askAppDescription, cfg.appDescription), {
          parse_mode: "HTML",
        });
      }
      (ctx as BotContext).session.tgapi = { state: "prefDesc" };
      (ctx as BotContext).session.tgapiPendingSlot = { success, fail };
      return;
    }
    if (func === "language") {
      if (registry.languageRunner) {
        await registry.languageRunner(ctx);
        return;
      }
    }
    await ctx.reply(`⚠️ 未知的 TGAPI 功能：${func}`);
    console.warn(`TGAPI bot #${botId} unknown tgapi_func from user ${from.id}: ${func}`);
  };

  // v2.1.16 动态提示消息上的功能按钮（如「已创建 → 💎 我的API」）：与菜单按钮同一执行器
  bot.callbackQuery(new RegExp(`^${TGAPI_FUNC_CALLBACK_PREFIX}(.+)$`), async (ctx) => {
    const func = ctx.match?.[1]?.trim() ?? "";
    const lang = langOf(ctx as BotContext);
    if (!func || !(await guideTgApiFuncToPrivate(ctx as BotContext, lang))) {
      const from = ctx.from;
      if (from && !from.is_bot) {
        if (func === "my") {
          await runMyApi(ctx as BotContext, lang);
        } else if (func === "create") {
          // 已创建检测通过的入口（如重复点击创建API提示）：不再叠加门禁
          await runCreateApi(ctx as BotContext, lang, false);
        } else if (func === "start") {
          await sendTgApiStartMessage(ctx as BotContext, lang);
        } else {
          await ctx.reply(`⚠️ 未知的 TGAPI 功能：${func}`);
        }
      }
    }
    await ctx.answerCallbackQuery().catch(() => undefined);
  });

  // ---------------------------------------------------------------------------
  // 加群申请自动通过（v2.1.16 Bug 修复：TGAPI 分支此前未注册 chat_join_request，
  // 一键部署生成的申请制加群链接点击后机器人完全无反应、无私聊、不自动通过审核）
  // ---------------------------------------------------------------------------
  // TGAPI 申请机器人的群组（一键部署生成的「My Telegram API」申请制群组）不设加群验证：
  // 收到申请即自动通过（与真实 APP 群组加群逻辑一致），门禁在私聊创建API流程中完成。
  // 管理后台「TGAPI申请」弹窗仿真屏的申请加群流程与此一一对应。
  bot.on("chat_join_request", async (ctx) => {
    const joinRequest = ctx.chatJoinRequest;
    if (!joinRequest) return;
    const { from: requestUser, chat } = joinRequest;
    const approval = await approveTelegramJoinRequest(BigInt(chat.id), BigInt(requestUser.id), ctx.api);
    console.log(
      `TGAPI bot #${botId} join request: user ${requestUser.id} (${requestUser.username ?? "no username"}) ` +
        `to chat ${chat.id} -> ${approval.success ? "auto-approved" : `failed: ${approval.error ?? "unknown"}`}`,
    );
  });

  /**
   * 开始申请流程（已解锁用户，v2.2.2）：直接进入手机号状态 —— 创建流程不再
   * 收集可选 APP 参数（askAppDetails 已移除，APP 参数用键盘预配置或管理端默认）。
   */
  async function beginApplication(ctx: BotContext, lang: TgApiLang): Promise<void> {
    const texts = resolveTgApiTexts(cfg, lang);
    ctx.session.tgapi = { state: "phone" };
    await ctx.reply(texts.askPhone, { parse_mode: "HTML" });
  }

  /** /start 入口（对应原 ConversationHandler entry_point + fallback；仅私聊） */
  async function startConversation(ctx: BotContext): Promise<void> {
    const from = ctx.from;
    if (!from || from.is_bot) return;
    const lang = langOf(ctx);
    // v2.1.16（需求4）：/start 启动机器人 = 重新发送一条新的初始消息+内嵌按钮，
    // 之前的消息和内嵌按钮过时失效（旧键盘移除 + 过期拦截见 sendTgApiStartMessage）。
    // 门禁由「创建API」按钮按需触发，不再按解锁状态分流。
    await sendTgApiStartMessage(ctx, lang);
  }

  /**
   * 指令失败消息槽位（v2.1.16）：创建流程失败时追加发送按钮配置的 tgapi_fail 模板
   *（{{error}} 变量 = 具体错误摘要；模板随点击按钮存入会话 pendingFail；未配置则不追加）。
   */
  async function sendFailTemplateMessage(ctx: BotContext, lang: TgApiLang, error: string): Promise<void> {
    const failTemplate = ctx.session.tgapi?.pendingFail;
    if (!failTemplate) return;
    const primary = (lang === "zh" ? failTemplate.zh : failTemplate.en).trim();
    const failRaw = primary || (lang === "zh" ? failTemplate.en : failTemplate.zh).trim();
    if (!failRaw) return;
    await ctx.reply(
      renderMenuTemplate(failRaw, {
        ...varsFromContext(ctx),
        error,
      }),
    );
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
    if (!phone.startsWith("+")) {
      // v2.2.8：非 + 开头 = 本地格式校验拦截（不发起真实 requestLoginCode 请求）
      await ctx.reply(texts.invalidPhoneFormat, { parse_mode: "HTML" });
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
        await sendFailTemplateMessage(ctx, lang, login.error || "my.telegram.org 登录被拒绝");
        ctx.session.tgapi = undefined;
        console.log(
          `TGAPI bot #${botId} my.telegram.org login rejected: user ${from.id} reason=${login.error.slice(0, 120)}`,
        );
        return;
      }

      // APP 参数：键盘「设置Title/设置Description/设置平台」预配置 > 管理端默认；
      // shortname 由 title 派生（my.telegram.org 要求字母开头 5-32 位）
      const prefTitle = ctx.session.tgapiPrefTitle?.trim() ?? "";
      const prefDesc = ctx.session.tgapiPrefDesc?.trim() ?? "";
      const effectiveTitle = prefTitle || cfg.appTitle;
      const effectiveDescription = prefDesc || cfg.appDescription;
      const effectiveShortName = deriveTgApiShortName(effectiveTitle, cfg.appShortName);
      const prefPlatform = ctx.session.tgapiPlatform;
      const effectivePlatform =
        prefPlatform && isValidTgApiPlatformValue(prefPlatform)
          ? prefPlatform
          : cfg.appPlatforms[0];

      // 原实现：抓取现有 APP → 无则按参数创建 → 再抓取（stars have failed us 兜底）
      let scraped: TgOrgScrapeResult | null = null;
      let createError = "";
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
            appPlatform: effectivePlatform,
            appDescription: effectiveDescription,
          });
          console.log(
            `TGAPI bot #${botId} app created: user ${from.id} title="${effectiveTitle}" ` +
              `shortname=${effectiveShortName} platform=${effectivePlatform}`,
          );
        } catch (error) {
          createError = briefError(error);
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
        // v2.1.16（需求5）：APP 结果落库（tgapi_bot_users）——「我的API」图2格式展示
        // 与「创建API」门禁前已创建检测的数据源
        await saveTgApiBotUser({
          botId,
          userId: BigInt(from.id),
          appPhone: flow.phone,
          appId: scraped.info.appId,
          appHash: scraped.info.apiHash,
        });
        // v2.1.10：footer 留空 = 不附加任何署名（不再默认拼接原项目作者推广文案）
        const resultHtml =
          buildAppResultHTML(flow.phone, scraped.info) +
          (cfg.footerText ? `\n\n${cfg.footerText}` : "");
        await editProgress(resultHtml, true);
        // v2.1.16 指令消息槽位：按钮配置了成功消息模板时追加发送（{{phone}}/{{api_id}}/{{api_hash}}）
        const successTemplate = flow.pendingSuccess;
        if (successTemplate) {
          const primary = (lang === "zh" ? successTemplate.zh : successTemplate.en).trim();
          const successRaw = primary || (lang === "zh" ? successTemplate.en : successTemplate.zh).trim();
          if (successRaw) {
            await ctx.reply(
              renderMenuTemplate(successRaw, {
                ...varsFromContext(ctx),
                phone: flow.phone,
                api_id: scraped.info.appId,
                api_hash: scraped.info.apiHash,
              }),
            );
          }
        }
        console.log(
          `TGAPI bot #${botId} app credentials delivered: user ${from.id} app_id=${scraped.info.appId}`,
        );
      } else {
        await editProgress(texts.erredPage, false);
        await sendFailTemplateMessage(
          ctx,
          lang,
          createError || "APP 抓取/创建失败（my.telegram.org 页面不可用）",
        );
      }
    } catch (error) {
      console.error(`TGAPI bot #${botId} login/scrape pipeline failed: user ${from.id}:`, error);
      const brief = briefError(error);
      await editProgress(
        `${sys.pipelineFail(brief)}\n\n${texts.erredPage}`,
        false,
      );
      await sendFailTemplateMessage(ctx, lang, brief);
    }
    // 原实现：ConversationHandler.END（无论成败，登录码状态一律终结；
    // 解锁状态不受影响 —— 同一用户后续再次申请无需再次解锁）
    ctx.session.tgapi = undefined;
  }

  // ---------------------------------------------------------------------------
  // 私聊消息处理（v2.2.2 门禁 Router 双路由：locked = 门禁组件 / open = 本函数）
  // TGAPI 机器人是纯私聊工具机器人；群聊消息一律透传/忽略
  // ---------------------------------------------------------------------------

  /** open 路由：已解锁用户的私聊消息（偏好收集/手机号/登录码/无状态重入） */
  async function handleUnlockedPrivateMessage(
    ctx: BotContext,
    messageText: string | null,
    contactPhone: string | null,
  ): Promise<void> {
    const from = ctx.from;
    if (!from || from.is_bot) return;
    const lang = langOf(ctx);
    const flow = ctx.session.tgapi;

    // 设置Title/设置Description 偏好收集（只记录偏好，创建 API 时优先使用）
    if (flow?.state === "prefTitle" || flow?.state === "prefDesc") {
      const sys = TGAPI_SYSTEM_TEXTS[lang];
      const input = (messageText ?? "").trim();
      const slot = ctx.session.tgapiPendingSlot;
      ctx.session.tgapi = undefined;
      ctx.session.tgapiPendingSlot = undefined;
      if (flow.state === "prefTitle") {
        if (!input || input.length > APP_TITLE_MAX_LENGTH) {
          await ctx.reply(sys.titleInvalid);
          return;
        }
        ctx.session.tgapiPrefTitle = input;
        const raw = responseText(slot?.success, lang) || resolveTgApiTexts(cfg, lang).titleSet;
        await ctx.reply(renderMenuTemplate(raw, { ...varsFromContext(ctx), title: input }));
        return;
      }
      if (!input || input.length > APP_DESCRIPTION_MAX_LENGTH) {
        await ctx.reply(sys.descriptionInvalid);
        return;
      }
      ctx.session.tgapiPrefDesc = input;
      const raw = responseText(slot?.success, lang) || resolveTgApiTexts(cfg, lang).descriptionSet;
      await ctx.reply(renderMenuTemplate(raw, { ...varsFromContext(ctx), description: input }));
      return;
    }

    if (messageText && messageText.startsWith("/")) {
      // 命令交给 command 中间件（仅指令菜单弹窗勾选的指令有处理器；
      // /start 已勾选注册时重入语义与原 fallback 一致）
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
  // 中间件装配（顺序：问题插件 → 门禁 Router → 授权认证 callback → 指令 → 支付）
  // ---------------------------------------------------------------------------

  bot.use(unlockQuestion.middleware());

  // 通用门禁 Router（tgapi-gate.ts 组件）：locked 路由 = 门禁全部行为（captcha 输码
  // 真实外部核验 / stars 发票与支付等待），open 路由 = 已解锁业务处理；指令与支付
  // 类更新透传下游（路由函数返回 undefined）。force-reply 回复由上方问题插件先行消费。
  bot.use(
    createTgApiGateRouter({
      deps: gateDeps,
      langOf,
      sendCaptchaPrompt: async (ctx, lang) => {
        // 唯一门禁提示（v2.2.2：不再叠加「请在下方的输入框进行输入」输入提示）
        const texts = resolveTgApiTexts(cfg, lang);
        await unlockQuestion.replyWithHTML(ctx, htmlEscape(texts.unlockPrompt));
      },
      onCaptchaAttempt: (ctx, lang, code) => handleUnlockAttempt(ctx, lang, code),
      onOpen: (ctx, messageText, contactPhone) =>
        handleUnlockedPrivateMessage(ctx, messageText, contactPhone),
    }),
  );

  // ---------------------------------------------------------------------------
  // 语言切换（v2.1.14）：不再是 /language 指令 —— 按钮化
  // ---------------------------------------------------------------------------
  // 管理端在「消息内嵌按钮」配置「语言切换」按钮（action.type=language），点击后
  // 在 zh/en 间切换并回复确认；会话记忆语言偏好（新会话按用户 language_code 自动
  // 识别）。运行器经 registry.languageRunner 注入：菜单插件安装早于本函数，但
  // appendButton 在点击时才查找同一注册表对象，注入顺序不影响真实执行。
  registry.languageRunner = async (ctx) => {
    const from = ctx.from;
    if (!from || from.is_bot) return;
    const next: TgApiLang = langOf(ctx as BotContext) === "zh" ? "en" : "zh";
    (ctx as BotContext).session.tgapiLang = next;
    await ctx.reply(TGAPI_SYSTEM_TEXTS[next].languageHelp(next));
    console.log(
      `TGAPI bot #${botId} language switched via menu button: user ${from.id} -> ${next}`,
    );
  };

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
        // 点击后发送唯一门禁提示（StatelessQuestion force-reply，要求在输入框输入验证码）
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
  // 指令注册（唯一来源：机器人管理页「⌨️ 指令菜单」弹窗勾选，bots.config.commandIds；
  // 勾选清单与同步任务已在函数开头与自定义键盘模式共用，见 selectedItems / myCommands）
  // ---------------------------------------------------------------------------

  // 内置指令：注册勾选项（/start 除外 —— TGAPI 的 /start 在下方按勾选单独注册，
  // 执行 TGAPI 启动语义而非通用欢迎指令，避免同一 /start 双响应）。
  // registerBuiltinCommandHandlers 同步填充菜单「执行指令」按钮注册表（真实处理器，
  // adminOnly 闭包自校验防越权）并注册 bot.command（手输 /指令 同源）。
  const selectedBuiltin = selectedItems
    .filter((item) => item.type === "builtin" && item.name !== "start")
    .map((item) => ({ name: item.name, intro: item.intro, description: item.description }));
  registerBuiltinCommandHandlers(bot, selectedBuiltin, registry);

  // /start（v2.1.14）：唯一启动指令，必须自行配置 —— 绝不硬编码注册。仅当管理员在
  // 「⌨️ 指令菜单」弹窗勾选指令库 /start 条目（bots.config.commandIds 包含其 id）时，
  // 此处才注册响应（TGAPI 启动语义：私聊 = 启动申请流程/门禁欢迎；群组 = 欢迎+
  // 授权认证按钮引导私聊）；未勾选 = 不注册、不响应。同步填充菜单「执行指令」
  // 按钮注册表：按钮指向 /start 时点击与手输完全同源。
  const startSelected = selectedItems.some(
    (item) => item.type === "builtin" && item.name === "start",
  );
  if (startSelected) {
    const startRunner: MenuCommandRunner = async (ctx) => {
      const chatType = ctx.chat?.type;
      if (chatType === "private") {
        await startConversation(ctx as BotContext);
        return;
      }
      if (chatType === "group" || chatType === "supergroup") {
        // v2.1.16：群组 /start 同样发送初始消息+内嵌按钮（图1），按钮点击后在群内引导私聊完成
        await sendTgApiStartMessage(ctx as BotContext, langOf(ctx as BotContext));
      }
    };
    // grammY 原生支持定向指令：群内 /start@本机器人 才匹配，/start@其他机器人 不响应
    bot.command("start", (ctx) => startRunner(ctx));
    registry.runners.set("start", startRunner);
  }

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
    `TGAPI bot #${botId} commands registered (menu selection only): builtin=[${selectedBuiltin.map((item) => item.name).join(", ") || "none"}]${startSelected ? " +start" : ""} custom=[${customItems.map((item) => item.name).join(", ") || "none"}]`,
  );

  // 私聊文本/联系人消息已由上方门禁 Router 双路由统一受理（locked = 门禁 / open =
  // handleUnlockedPrivateMessage），此处不再重复注册消息处理器（避免双响应）。

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
    // 解锁落库 + 回读校验（通用门禁组件共享实现；回读失败绝不发送成功语义）
    const persisted = await persistTgApiUnlock(
      gateDeps,
      BigInt(from.id),
      from.username ?? null,
      "stars",
    );
    if (!persisted) {
      await ctx.reply(TGAPI_SYSTEM_TEXTS[lang].unlockPersistFail);
      return;
    }
    ctx.session.tgapiStarsInvoiceSent = false;
    // 支付成功 → 直接进入下一步（单条手机号提示；不再发送单独成功消息）
    await beginApplication(ctx, lang);
    console.log(
      `TGAPI bot #${botId} unlocked via stars: user ${from.id} paid ${payment.total_amount} XTR (${payment.telegram_payment_charge_id})`,
    );
  });

  // 指令同步任务：仅勾选指令写入 Telegram 指令菜单（syncCommands 见函数开头）
  return syncCommands;
}
