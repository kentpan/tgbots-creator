/**
 * TGAPI申请 机器人配置（v2.1.7）—— grammY 复刻 SpEcHiDe/MyTelegramOrgRoBot。
 *
 * 原项目把全部可调参数放在 config.env（Config 类）+ bot/translation.py（Translation 类）；
 * 本实现把同样的参数收敛为 bots.config JSON 的 tgapi 段，由管理后台「TGAPI申请」页面
 * 创建/配置（对应原项目改 config.env + 重启的流程）。
 *
 * v2.1.7 变更：
 * - 对话文案只支持中文/英文两套（内置双语文案 + 按用户 language_code 自动识别，
 *   /language 指令手动切换）；文案覆盖从单语言改为按语言（zh/en）覆盖，
 *   旧版扁平 texts 覆盖自动迁移为 zh 覆盖（兼容既有机器人配置）。
 * - 新增 askAppDetails：申请人可自定义 APP 名称（title）与描述（description），
 *   跳过（/skip）时回落下方 APP 创建默认参数。
 */

/** 机器人对话语言（v2.1.7 起仅支持中英文两套） */
export type TgApiLang = "zh" | "en";

/** 验证码解锁 / 星星解锁（可在管理后台切换，对应原项目没有的增值门禁） */
export type TgApiUnlockMode = "captcha" | "stars";

/** my.telegram.org APP 创建平台清单（原 Config.APP_PLATFORM 逐字保留） */
export const TGAPI_APP_PLATFORMS = [
  "android",
  "ios",
  "wp",
  "bb",
  "desktop",
  "web",
  "ubp",
  "other",
] as const;

/** 单语言对话文案（原 bot/translation.py + 增值门禁/申请人自定义 APP 提示） */
export interface TgApiBotTexts {
  /** 原 START_TEXT（/start 欢迎语；askAppDetails 关闭时兼作手机号提示） */
  start: string;
  /** 申请人自定义 APP：APP 名称（title）提示，{default} 占位符替换为默认值 */
  askAppTitle: string;
  /** 申请人自定义 APP：APP 描述（description）提示，{default} 占位符替换为默认值 */
  askAppDescription: string;
  /** 申请人自定义 APP：描述录入完成后的手机号提示 */
  askPhone: string;
  /** 原 AFTER_RECVD_CODE_TEXT */
  afterRecvdCode: string;
  /** 原 BEFORE_SUCC_LOGIN */
  beforeSuccLogin: string;
  /** 原 ERRED_PAGE */
  erredPage: string;
  /** 原 IN_VALID_CODE_PVDED */
  invalidCode: string;
  /** 原 IN_VALID_PHNO_PVDED */
  invalidPhone: string;
  /** 增值功能：首次对话解锁提示（验证码模式） */
  unlockPrompt: string;
  /** 增值功能：解锁成功提示 */
  unlockSuccess: string;
}

/** 内置中文文案（v2.1.10 起全部重写：不再携带原项目作者 SpEcHlDe 的推广链接/署名） */
export const TGAPI_TEXTS_ZH: TgApiBotTexts = {
  start: [
    "💀 欢迎使用 API 生成机器人！\n\n",
    "本机器人可为您自己的 Telegram 账号自动生成 api_id 和 api_hash。\n\n",
    "👇 请选择下面的方式之一：",
  ].join(""),
  askAppTitle: "📝 请发送你要申请的 APP 名称（App title，1-32 个字符）\n发送 /skip 使用默认：{default}",
  askAppDescription: "📄 请发送 APP 描述（App description）\n发送 /skip 使用默认：{default}",
  askPhone: "📱 请发送你的 Telegram 手机号（国际格式，如 +8613800138000）\n\n任意阶段发送 /start 可重新输入资料",
  afterRecvdCode: [
    "收到！\n",
    "现在请发送你从 Telegram 收到的登录码！\n\n",
    "该验证码仅用于从 my.telegram.org 获取 APP ID\n\n",
    "任意阶段发送 /start 可重新输入资料",
  ].join(""),
  beforeSuccLogin: "已收到验证码，正在抓取页面 ...",
  erredPage: "出错了，获取 APP ID 失败。请稍后重试，或发送 /start 重新开始。",
  invalidCode: "抱歉，输入内容似乎不是有效的 Telegram 网页登录码",
  invalidPhone: "抱歉，输入内容似乎不是有效的手机号",
  unlockPrompt:
    "🔒 本机器人仅对已解锁用户开放。\n\n首次使用请先解锁：请回复本消息并输入解锁验证码。",
  unlockSuccess: "✅ 解锁成功，欢迎使用！",
};

/** 内置英文文案（v2.1.10 起同步重写：不再携带原项目作者推广链接/署名） */
export const TGAPI_TEXTS_EN: TgApiBotTexts = {
  start: [
    "💀 Welcome to the API Generator Bot!\n\n",
    "This bot automatically generates api_id and api_hash for your own Telegram account.\n\n",
    "👇 Please choose one of the options below:",
  ].join(""),
  askAppTitle:
    "📝 Please send the App title for your application (1-32 characters).\n" +
    "Send /skip to use the default: {default}",
  askAppDescription:
    "📄 Please send the App description for your application.\n" +
    "Send /skip to use the default: {default}",
  askPhone:
    "📱 Please send your Telegram phone number in international format, e.g. +14155552671\n\n" +
    "/start at any stage to re-enter your details",
  afterRecvdCode: [
    "I see!\n",
    "now please send the Telegram code that you received from Telegram!\n\n",
    "this code is only used for the purpose of getting the APP ID from my.telegram.org\n\n",
    "/start at any stage to re-enter your details",
  ].join(""),
  beforeSuccLogin: "Code received. Scraping web page ...",
  erredPage:
    "Something went wrong. Failed to get the APP ID. Please try again later, or send /start to restart.",
  invalidCode:
    "sorry, but the input does not seem to be a valid Telegram Web-Login code",
  invalidPhone:
    "sorry, but the input does not seem to be a valid phone number",
  unlockPrompt:
    "🔒 This bot is only available to unlocked users.\n\n" +
    "First time here? Please unlock: reply to this message and send your unlock code.",
  unlockSuccess: "✅ Unlocked successfully, welcome!",
};

/**
 * 运行期系统提示（不开放管理端覆盖；中文/英文两套）。
 * 与 TgApiBotTexts 的区别：这些是机器人异常/系统态提示，配置面只覆盖常规对话文案。
 */
export interface TgApiSystemTexts {
  networkRetry: string;
  /** 输入提示（v2.1.14：需要用户在输入框输入的交互，force-reply 提问前先发送） */
  inputHint: string;
  /** 网络故障后追加的说明（外部 API 核验网络错误不计入任何代价） */
  unlockNetworkRetry: string;
  switchedToStars: string;
  methodMissing: string;
  methodUnavailable: string;
  methodConfigInvalid: string;
  starsNotConfigured: string;
  starsInvoiceHint: (amount: string) => string;
  starsInvoicePending: string;
  sessionLost: string;
  requestLoginCodeFail: (error: string) => string;
  pipelineFail: (error: string) => string;
  languageHelp: (current: string) => string;
  languageInvalid: string;
  titleInvalid: string;
  descriptionInvalid: string;
}

export const TGAPI_SYSTEM_TEXTS: Record<TgApiLang, TgApiSystemTexts> = {
  zh: {
    networkRetry: "🌐 网络波动，正在重试...",
    inputHint: "✍🏻 请在下方的输入框进行输入:",
    unlockNetworkRetry: "本次未消耗任何额度，请重新发送解锁验证码。",
    switchedToStars: "当前解锁方式已切换为星星支付，请发送 /start 获取支付发票。",
    methodMissing: "机器人尚未配置解锁验证方式，请联系管理员。",
    methodUnavailable: "解锁验证方式不可用，请联系管理员。",
    methodConfigInvalid: "解锁配置异常，请联系管理员。",
    starsNotConfigured: "机器人尚未配置星星解锁金额，请联系管理员。",
    starsInvoiceHint: (amount) =>
      `💡 请在上方发票中点击「支付 ${amount} ⭐」完成解锁；支付成功后将自动开始 TGAPI 申请流程。`,
    starsInvoicePending:
      "请先完成星星解锁：点击支付发票中的「支付」按钮；发送 /start 可重新获取发票。",
    sessionLost: "会话状态已丢失，请重新发送手机号（或发送 /start 重新开始）。",
    requestLoginCodeFail: (error) =>
      `请求登录码失败：${error}\n\n请重新发送手机号（国际格式，如 +8613800138000）。`,
    pipelineFail: (error) => `处理失败：${error}`,
    languageHelp: (current) =>
      `🌐 当前语言 / Current language：${current === "zh" ? "中文" : "English"}\n\n` +
      "切换语言 / Switch language：/language zh 或 /language en",
    languageInvalid: "未识别的语言，请使用 /language zh 或 /language en",
    titleInvalid: "APP 名称不合法：请输入 1-32 个字符，或发送 /skip 使用默认值。",
    descriptionInvalid: "APP 描述不合法：请输入 1-200 个字符，或发送 /skip 使用默认值。",
  },
  en: {
    networkRetry: "🌐 Network fluctuation, retrying...",
    inputHint: "✍🏻 Please type in the input field below:",
    unlockNetworkRetry:
      "Nothing was consumed this time. Please send your unlock code again.",
    switchedToStars:
      "Unlocking has been switched to Telegram Stars. Please send /start to get the payment invoice.",
    methodMissing:
      "The unlock verification method has not been configured yet. Please contact the admin.",
    methodUnavailable:
      "The unlock verification method is currently unavailable. Please contact the admin.",
    methodConfigInvalid: "The unlock configuration is broken. Please contact the admin.",
    starsNotConfigured:
      "The Stars unlock amount has not been configured yet. Please contact the admin.",
    starsInvoiceHint: (amount) =>
      `💡 Please tap "Pay ${amount} ⭐" on the invoice above to unlock; the TGAPI application flow will start automatically afterwards.`,
    starsInvoicePending:
      "Please finish the Stars unlock first: tap \"Pay\" on the payment invoice above; send /start to get a new invoice.",
    sessionLost:
      "The conversation state was lost. Please send your phone number again (or send /start to restart).",
    requestLoginCodeFail: (error) =>
      `Failed to request the login code: ${error}\n\nPlease send your phone number again (international format, e.g. +14155552671).`,
    pipelineFail: (error) => `Processing failed: ${error}`,
    languageHelp: (current) =>
      `🌐 当前语言 / Current language：${current === "zh" ? "中文" : "English"}\n\n` +
      "切换语言 / Switch language：/language zh 或 /language en",
    languageInvalid: "Unrecognized language. Please use /language zh or /language en",
    titleInvalid:
      "Invalid App title: please send 1-32 characters, or send /skip to use the default.",
    descriptionInvalid:
      "Invalid App description: please send 1-200 characters, or send /skip to use the default.",
  },
};

/** 按用户 language_code 自动识别对话语言：zh* → 中文，其余（含未知）→ 英文 */
export function detectTgApiLang(languageCode: string | undefined | null): TgApiLang {
  return typeof languageCode === "string" && languageCode.toLowerCase().startsWith("zh")
    ? "zh"
    : "en";
}

export interface TgApiBotConfig {
  enabled: boolean;
  /** 解锁方式：captcha=外部 API 验证码（复用验证方式库 code_api）；stars=Telegram 星星支付 */
  unlockMode: TgApiUnlockMode;
  /** captcha 模式：使用的验证方式 id（verification_methods.id，type=code_api） */
  verificationMethodId?: number;
  /** stars 模式：解锁星星数量（XTR，整数） */
  starsAmount?: number;
  /** stars 模式：发票标题 */
  starsTitle?: string;
  /** v2.1.7 申请人自定义 APP 名称/描述（默认开启；关闭则始终使用下方默认参数创建） */
  askAppDetails: boolean;
  /** 原 Config.APP_TITLE（申请人跳过/自定义关闭时的默认值） */
  appTitle: string;
  /** 原 Config.APP_SHORT_NAME */
  appShortName: string;
  /** 原 Config.APP_URL */
  appUrl: string;
  /** 原 Config.APP_PLATFORM（管理后台勾选；随机选一提交） */
  appPlatforms: string[];
  /** 原 Config.APP_DESCRIPTION（申请人跳过/自定义关闭时的默认值） */
  appDescription: string;
  /** 原 Config.FOOTER_TEXT */
  footerText: string;
  /** 按语言文案覆盖（v2.1.7：texts.zh / texts.en；旧版扁平字符串键自动按 zh 迁移） */
  texts?: { zh?: Partial<TgApiBotTexts>; en?: Partial<TgApiBotTexts> };
}

/**
 * 默认 APP 创建参数（v2.1.10 起全部换为中性默认值：不再携带原项目作者
 * UseTGxBot/SpEcHlDe 的推广链接与署名；footerText 默认空 = 结果消息不附加署名）。
 */
export const TGAPI_DEFAULT_APP: {
  appTitle: string;
  appShortName: string;
  appUrl: string;
  appPlatforms: string[];
  appDescription: string;
  footerText: string;
} = {
  appTitle: "usetgapibot",
  appShortName: "usetgapibot",
  appUrl: "https://www.telegram.org",
  appPlatforms: [...TGAPI_APP_PLATFORMS],
  appDescription: "My Telegram App",
  footerText: "",
};

/**
 * v2.1.10 垃圾默认值迁移（v2.1.9 及更早版本内置默认值携带原项目作者的
 * 推广链接/署名，且旧版表单会把默认值固化进 bots.config）——
 * 仅对逐字等于下列旧默认常量的值做确定性迁移，管理员自定义值一律不动。
 */
const LEGACY_GARBAGE_VALUES: Record<string, string> = {
  "https://telegram.dog/UseTGxBot": TGAPI_DEFAULT_APP.appUrl,
  "created using https://telegram.dog/UseTGxBot": TGAPI_DEFAULT_APP.appDescription,
  "❤️ @SpEcHlDe": TGAPI_DEFAULT_APP.footerText,
};

/** 取配置字符串并迁移旧垃圾默认值（逐字相等才迁移） */
function pickMigratedString(value: unknown): string | undefined {
  const trimmed = typeof value === "string" && value.trim() ? value.trim() : undefined;
  if (trimmed === undefined) return undefined;
  return LEGACY_GARBAGE_VALUES[trimmed] ?? trimmed;
}

/** 文案覆盖字段的表单名 → TgApiBotTexts 键（管理后台按语言分组渲染/读取共用） */
export const TGAPI_TEXT_FIELD_KEYS = [
  { name: "start", label: "START_TEXT（/start 欢迎）" },
  { name: "askAppTitle", label: "APP 名称提示（申请人自定义）" },
  { name: "askAppDescription", label: "APP 描述提示（申请人自定义）" },
  { name: "askPhone", label: "手机号提示（申请人自定义流程）" },
  { name: "unlockPrompt", label: "解锁提示（验证码门禁）" },
  { name: "unlockSuccess", label: "解锁成功提示" },
] as const;

const TEXT_KEY_SET = new Set<string>(TGAPI_TEXT_FIELD_KEYS.map((item) => item.name));

/**
 * tgapi 配置段规范化：把未知来源的对象（bots.config JSON 解析结果）收敛为
 * 带完整默认值的 TgApiBotConfig。parseTgApiBotConfig（字符串入口）与 multi-runtime
 * （对象入口）共用，保证运行实例与管理后台读到同一份默认值。
 */
export function normalizeTgApiSection(tgapi: unknown): TgApiBotConfig {
  if (typeof tgapi !== "object" || tgapi === null) {
    return { enabled: false, unlockMode: "captcha", askAppDetails: true, ...TGAPI_DEFAULT_APP };
  }
  const cfg = tgapi as Record<string, unknown>;
  const unlockMode = cfg.unlockMode === "stars" ? "stars" : "captcha";
  const platforms = Array.isArray(cfg.appPlatforms)
    ? (cfg.appPlatforms as unknown[])
        .filter(
          (item): item is string =>
            typeof item === "string" && TGAPI_APP_PLATFORMS.includes(item as (typeof TGAPI_APP_PLATFORMS)[number]),
        )
    : [];
  const stringValue = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;

  // 文案覆盖兼容：v2.1.6 扁平 texts（键→字符串）视为中文覆盖；v2.1.7 起 texts.zh / texts.en
  const rawTexts = typeof cfg.texts === "object" && cfg.texts !== null ? (cfg.texts as Record<string, unknown>) : {};
  let zhSource: Record<string, unknown> = {};
  let enSource: Record<string, unknown> = {};
  const zhNode = rawTexts.zh;
  const enNode = rawTexts.en;
  if (typeof zhNode === "object" && zhNode !== null) zhSource = zhNode as Record<string, unknown>;
  if (typeof enNode === "object" && enNode !== null) enSource = enNode as Record<string, unknown>;
  for (const [key, value] of Object.entries(rawTexts)) {
    if (key === "zh" || key === "en") continue;
    if (typeof value === "string" && value.trim() && TEXT_KEY_SET.has(key)) {
      zhSource[key] = value;
    }
  }
  const pickTexts = (source: Record<string, unknown>): Partial<TgApiBotTexts> | undefined => {
    const picked: Partial<TgApiBotTexts> = {};
    for (const item of TGAPI_TEXT_FIELD_KEYS) {
      const value = stringValue(source[item.name]);
      if (value) picked[item.name] = value;
    }
    return Object.keys(picked).length > 0 ? picked : undefined;
  };

  return {
    enabled: cfg.enabled === true,
    unlockMode,
    verificationMethodId:
      typeof cfg.verificationMethodId === "number" && cfg.verificationMethodId > 0
        ? Math.floor(cfg.verificationMethodId)
        : undefined,
    starsAmount:
      typeof cfg.starsAmount === "number" && Number.isFinite(cfg.starsAmount) && cfg.starsAmount >= 1
        ? Math.floor(cfg.starsAmount)
        : undefined,
    starsTitle: stringValue(cfg.starsTitle),
    askAppDetails: cfg.askAppDetails !== false,
    // v2.1.10：读取时迁移旧垃圾默认值（运行实例与管理后台读到同一份干净配置）
    appTitle: pickMigratedString(cfg.appTitle) ?? TGAPI_DEFAULT_APP.appTitle,
    appShortName: pickMigratedString(cfg.appShortName) ?? TGAPI_DEFAULT_APP.appShortName,
    appUrl: pickMigratedString(cfg.appUrl) ?? TGAPI_DEFAULT_APP.appUrl,
    appPlatforms: platforms.length > 0 ? platforms : [...TGAPI_DEFAULT_APP.appPlatforms],
    appDescription: pickMigratedString(cfg.appDescription) ?? TGAPI_DEFAULT_APP.appDescription,
    footerText: pickMigratedString(cfg.footerText) ?? TGAPI_DEFAULT_APP.footerText,
    texts: {
      zh: pickTexts(zhSource),
      en: pickTexts(enSource),
    },
  };
}

/**
 * 从 bots.config JSON 解析 tgapi 段（缺省字段全部回落默认值）。
 * 未启用 / JSON 异常时返回 enabled=false 的配置（multi-runtime 据此跳过 TGAPI 能力）。
 */
export function parseTgApiBotConfig(raw: string): TgApiBotConfig {
  let profile: unknown;
  try {
    profile = JSON.parse(raw);
  } catch (error) {
    console.error(`parseTgApiBotConfig: bots.config JSON 解析失败:`, error);
    return { enabled: false, unlockMode: "captcha", askAppDetails: true, ...TGAPI_DEFAULT_APP };
  }
  if (typeof profile !== "object" || profile === null) {
    return { enabled: false, unlockMode: "captcha", askAppDetails: true, ...TGAPI_DEFAULT_APP };
  }
  return normalizeTgApiSection((profile as { tgapi?: unknown }).tgapi);
}

/** 组装某语言的对话文案：配置覆盖值（该语言）> 内置该语言默认文案 */
export function resolveTgApiTexts(cfg: TgApiBotConfig, lang: TgApiLang): TgApiBotTexts {
  const overrides = lang === "zh" ? cfg.texts?.zh : cfg.texts?.en;
  const builtin = lang === "zh" ? TGAPI_TEXTS_ZH : TGAPI_TEXTS_EN;
  return {
    start: overrides?.start?.trim() || builtin.start,
    askAppTitle: overrides?.askAppTitle?.trim() || builtin.askAppTitle,
    askAppDescription: overrides?.askAppDescription?.trim() || builtin.askAppDescription,
    askPhone: overrides?.askPhone?.trim() || builtin.askPhone,
    afterRecvdCode: overrides?.afterRecvdCode?.trim() || builtin.afterRecvdCode,
    beforeSuccLogin: overrides?.beforeSuccLogin?.trim() || builtin.beforeSuccLogin,
    erredPage: overrides?.erredPage?.trim() || builtin.erredPage,
    invalidCode: overrides?.invalidCode?.trim() || builtin.invalidCode,
    invalidPhone: overrides?.invalidPhone?.trim() || builtin.invalidPhone,
    unlockPrompt: overrides?.unlockPrompt?.trim() || builtin.unlockPrompt,
    unlockSuccess: overrides?.unlockSuccess?.trim() || builtin.unlockSuccess,
  };
}

/** 渲染 {default} 占位符（APP 名称/描述提示共用） */
export function renderTgApiTextTemplate(text: string, defaultValue: string): string {
  return text.replaceAll("{default}", defaultValue);
}

/**
 * 由申请人自定义的 APP 名称派生 my.telegram.org 必填的 short name：
 * 仅保留小写字母数字；不足 5 位或以数字开头时回落管理端默认 shortname
 *（my.telegram.org 对 shortname 要求：字母开头、5-32 位）。
 */
export function deriveTgApiShortName(appTitle: string, fallback: string): string {
  const slug = appTitle.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const normalized = /^[a-z]/.test(slug) ? slug : `app${slug}`;
  if (normalized.length < 5) return fallback;
  return normalized.slice(0, 32);
}
