/**
 * TGAPI申请 机器人配置（v2.1.7）—— grammY 复刻 SpEcHiDe/MyTelegramOrgRoBot。
 *
 * 原项目把全部可调参数放在 config.env（Config 类）+ bot/translation.py（Translation 类）；
 * 本实现把同样的参数收敛为 bots.config JSON 的 tgapi 段，由管理后台「TGAPI申请」页面
 * 创建/配置（对应原项目改 config.env + 重启的流程）。
 *
 * v2.1.7 变更：
 * - 对话文案只支持中文/英文两套（内置双语文案 + 按用户 language_code 自动识别，
 *   v2.1.14 起语言切换为消息内嵌按钮「语言切换」（action.type=language），
 *   不再提供 /language 指令）；文案覆盖从单语言改为按语言（zh/en）覆盖，
 *   旧版扁平 texts 覆盖自动迁移为 zh 覆盖（兼容既有机器人配置）。
 * v2.2.2 变更：
 * - askAppDetails（申请人对话中自定义 APP 名称/描述）移除：创建 API 直接
 *   手机号 → 登录码，APP 参数用键盘「设置Title/设置Description/设置平台」
 *   预配置（会话偏好）或管理端默认值（平台随机选一）。
 * - /skip 指令移除；unlockSuccess 单独成功消息移除（解锁后直接进入下一步，
 *   消灭双消息）；全部常规对话文案纳入 TgApiBotTexts（配置框预填默认值）。
 */

import {
  parseCustomKeyboardConfig,
  type CustomKeyboardConfig,
} from "@/services/custom-keyboard";

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

/**
 * 单语言对话文案（v2.2.2 起全量可配置：机器人发出的每一条常规对话消息都在这里，
 * 管理端配置框全部预填内置默认值；{{var}} 槽位在发送时按真实上下文渲染）。
 */
export interface TgApiBotTexts {
  /** 主键盘菜单消息（/start 与各操作后附键盘重新显示的消息正文） */
  start: string;
  /** 门禁提示（唯一门禁消息：force-reply 提问 / 对话流程等待输码，不再叠加输入提示） */
  unlockPrompt: string;
  /** 手机号提示（request_contact 键盘随消息发送） */
  askPhone: string;
  /** 原 AFTER_RECVD_CODE_TEXT（登录码提示，随消息移除底部键盘） */
  afterRecvdCode: string;
  /** 原 BEFORE_SUCC_LOGIN（登录码受理后的提交进度提示） */
  beforeSuccLogin: string;
  /** 原 ERRED_PAGE（提交失败时编辑到进度消息） */
  erredPage: string;
  /** 原 IN_VALID_CODE_PVDED */
  invalidCode: string;
  /** 原 IN_VALID_PHNO_PVDED */
  invalidPhone: string;
  /** 设置Title 提示，{default} 占位符替换为管理端默认 APP 名称 */
  askAppTitle: string;
  /** 设置Description 提示，{default} 占位符替换为管理端默认 APP 描述 */
  askAppDescription: string;
  /** 帮助按钮/指令回复（未配置按钮槽位消息时使用） */
  helpText: string;
  /** 客服支持按钮/指令回复（未配置按钮槽位消息时使用） */
  supportText: string;
  /** 未匹配任何键盘按钮/指令时的提示 */
  unknownInputHint: string;
  /** 设置平台：平台键盘消息提示 */
  askPlatform: string;
  /** 设置平台完成确认，{{platform}} = 平台名（随主键盘一并重新显示） */
  platformSet: string;
  /** 设置Title 完成确认，{{title}} = 所设名称 */
  titleSet: string;
  /** 设置Description 完成确认，{{description}} = 所设描述 */
  descriptionSet: string;
  /** 创建API：已创建过时的提示 */
  alreadyCreated: string;
  /** 我的API：尚未创建时的提示 */
  myApiEmpty: string;
  /** 我的API：结果消息，{{phone}}/{{api_id}}/{{api_hash}} */
  myApiResult: string;
  /** 主菜单层收到联系人卡片时的提示 */
  contactAtMenu: string;
  /** my.telegram.org 登录被拒后的最终提示（附主键盘），{{error}} = 原因摘要 */
  loginRejected: string;
  /** request_contact 授权按钮文案 */
  shareContactLabel: string;
  /** request_contact 流程的取消按钮文案 */
  cancelLabel: string;
}

/** 内置中文文案（v2.2.2 起全量默认值：/skip 指令已移除，APP 参数用预配置或默认值） */
export const TGAPI_TEXTS_ZH: TgApiBotTexts = {
  start: [
    "💀 欢迎使用 API 生成机器人！\n\n",
    "本机器人可为您自己的 Telegram 账号自动生成 api_id 和 api_hash。\n\n",
    "👇 请选择下面的方式之一：",
  ].join(""),
  unlockPrompt:
    "🔒 本机器人仅对已解锁用户开放。\n\n首次使用请先解锁：请回复本消息并输入解锁验证码。",
  askPhone:
    "📱 请发送你的 Telegram 手机号（国际格式，如 +8613800138000），或点击下方按钮授权共享\n\n任意阶段发送 /start 可重新开始",
  afterRecvdCode: [
    "收到！\n",
    "现在请发送你从 Telegram 收到的登录码！\n\n",
    "该验证码仅用于从 my.telegram.org 获取 APP ID\n\n",
    "任意阶段发送 /start 可重新开始",
  ].join(""),
  beforeSuccLogin: "已收到验证码，正在提交 my.telegram.org ...",
  erredPage: "出错了，获取 APP ID 失败。请稍后重试，或发送 /start 重新开始。",
  invalidCode: "抱歉，输入内容似乎不是有效的 Telegram 网页登录码",
  invalidPhone: "抱歉，输入内容似乎不是有效的手机号",
  askAppTitle: "✏️ 请发送 APP 名称（App title，1-32 个字符）。\n当前默认：{default}\n\n任意阶段发送 /start 可重新开始",
  askAppDescription: "📝 请发送 APP 描述（App description，1-200 个字符）。\n当前默认：{default}\n\n任意阶段发送 /start 可重新开始",
  helpText:
    "🆘 使用帮助：\n\n" +
    "🗝 创建 API — 为你的 Telegram 账号自动生成 api_id 和 api_hash\n" +
    "🗂 我的 API — 查看已创建的 api_id 与 api_hash\n" +
    "📱 设置平台 — 选择创建 APP 时的平台（Android/iOS/桌面端等）\n" +
    "✅ 语言 — 中文/English 切换\n" +
    "✏️ 设置Title / 📝 设置Description — 自定义 APP 名称与描述\n" +
    "🎫 客服支持 — 联系管理员获取人工支持",
  supportText: "🎫 如需人工支持，请联系管理员。",
  unknownInputHint: "🤔 请使用下方键盘按钮或发送指令；发送 /start 重新显示主菜单。",
  askPlatform: "📱 请选择创建 APP 时使用的平台：",
  platformSet: "✅ APP 平台已设置为 {{platform}}，创建 API 时将使用。",
  titleSet: "✅ APP 名称已设置为：{{title}}",
  descriptionSet: "✅ APP 描述已设置为：{{description}}",
  alreadyCreated: "✅ 你的 api_id 和 api_hash 已创建，点击键盘「🗂 我的 API」查看。",
  myApiEmpty: "💎 你还没有创建 API。\n\n点击 🗝 创建API 开始申请。",
  myApiResult: "📱 号码：{{phone}}\n🆔 api_id：{{api_id}}\n🔑 api_hash：{{api_hash}}",
  contactAtMenu: "📱 请先点击键盘「🗝 创建 API」，机器人会向你请求手机号授权。",
  loginRejected:
    "❌ 登录被拒绝：{{error}}\n\n请重新点击「🗝 创建 API」再试，或发送 /start 返回主键盘。",
  shareContactLabel: "📱 共享我的手机号",
  cancelLabel: "❌ 取消",
};

/** 内置英文文案（与中文同结构全量默认值） */
export const TGAPI_TEXTS_EN: TgApiBotTexts = {
  start: [
    "💀 Welcome to the API Generator Bot!\n\n",
    "This bot automatically generates api_id and api_hash for your own Telegram account.\n\n",
    "👇 Please choose one of the options below:",
  ].join(""),
  unlockPrompt:
    "🔒 This bot is only available to unlocked users.\n\n" +
    "First time here? Please unlock: reply to this message and send your unlock code.",
  askPhone:
    "📱 Please send your Telegram phone number in international format, e.g. +14155552671, or tap the button below to share it\n\n" +
    "/start at any stage to restart",
  afterRecvdCode: [
    "I see!\n",
    "now please send the Telegram code that you received from Telegram!\n\n",
    "this code is only used for the purpose of getting the APP ID from my.telegram.org\n\n",
    "/start at any stage to restart",
  ].join(""),
  beforeSuccLogin: "Code received. Submitting to my.telegram.org ...",
  erredPage:
    "Something went wrong. Failed to get the APP ID. Please try again later, or send /start to restart.",
  invalidCode:
    "sorry, but the input does not seem to be a valid Telegram Web-Login code",
  invalidPhone:
    "sorry, but the input does not seem to be a valid phone number",
  askAppTitle:
    "✏️ Please send the App title (1-32 characters).\n" +
    "Current default: {default}\n\n/start at any stage to restart",
  askAppDescription:
    "📝 Please send the App description (1-200 characters).\n" +
    "Current default: {default}\n\n/start at any stage to restart",
  helpText:
    "🆘 How to use:\n\n" +
    "🗝 Create API — automatically generate api_id and api_hash for your Telegram account\n" +
    "🗂 My API — view your created api_id and api_hash\n" +
    "📱 Set Platform — choose the platform for your APP (Android/iOS/Desktop/…)\n" +
    "✅ Language — switch between 中文/English\n" +
    "✏️ Set Title / 📝 Set Description — customize your APP title and description\n" +
    "🎫 Support — contact the admin for human support",
  supportText: "🎫 For human support, please contact the admin.",
  unknownInputHint:
    "🤔 Please use the keyboard buttons below or send a command; send /start to show the main menu again.",
  askPlatform: "📱 Choose the platform for your APP:",
  platformSet: "✅ App platform set to {{platform}}; it will be used when creating your API.",
  titleSet: "✅ App title set to: {{title}}",
  descriptionSet: "✅ App description set to: {{description}}",
  alreadyCreated:
    "✅ Your api_id and api_hash have already been created. Tap 🗂 My API on the keyboard to view them.",
  myApiEmpty: "💎 You haven't created an API yet.\n\nTap 🗝 Create API to start.",
  myApiResult: "📱 Number: {{phone}}\n🆔 api_id: {{api_id}}\n🔑 api_hash: {{api_hash}}",
  contactAtMenu:
    "📱 Please tap 🗝 Create API first; the bot will request your phone number there.",
  loginRejected:
    "❌ Login rejected: {{error}}\n\nTap 🗝 Create API to retry, or send /start for the main menu.",
  shareContactLabel: "📱 Share my phone number",
  cancelLabel: "❌ Cancel",
};

/**
 * 运行期系统提示（不开放管理端覆盖；中文/英文两套）。
 * 与 TgApiBotTexts 的区别：这些是机器人异常/系统态提示，配置面只覆盖常规对话文案。
 */
export interface TgApiSystemTexts {
  networkRetry: string;
  /** 网络故障后追加的说明（外部 API 核验网络错误不计入任何代价） */
  unlockNetworkRetry: string;
  /** 解锁状态落库回读失败（绝不发送成功提示，直接要求重试） */
  unlockPersistFail: string;
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
  /** 语言切换按钮（v2.1.14 起 /language 指令已移除）点击后的切换确认文案 */
  languageHelp: (current: string) => string;
  titleInvalid: string;
  descriptionInvalid: string;
}

export const TGAPI_SYSTEM_TEXTS: Record<TgApiLang, TgApiSystemTexts> = {
  zh: {
    networkRetry: "🌐 网络波动，正在重试...",
    unlockNetworkRetry: "本次未消耗任何额度，请重新发送解锁验证码。",
    unlockPersistFail: "解锁状态保存失败，请稍后重试。",
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
      `✅ 语言已切换 / Language switched：${current === "zh" ? "中文" : "English"}`,
    titleInvalid: "APP 名称不合法：请输入 1-32 个字符。",
    descriptionInvalid: "APP 描述不合法：请输入 1-200 个字符。",
  },
  en: {
    networkRetry: "🌐 Network fluctuation, retrying...",
    unlockNetworkRetry:
      "Nothing was consumed this time. Please send your unlock code again.",
    unlockPersistFail: "Failed to save the unlock state. Please try again later.",
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
      `✅ 语言已切换 / Language switched：${current === "zh" ? "中文" : "English"}`,
    titleInvalid:
      "Invalid App title: please send 1-32 characters.",
    descriptionInvalid:
      "Invalid App description: please send 1-200 characters.",
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
  /** 原 Config.APP_TITLE（APP 创建参数；用户经设置Title 预配置时优先使用） */
  appTitle: string;
  /** 原 Config.APP_SHORT_NAME */
  appShortName: string;
  /** 原 Config.APP_URL */
  appUrl: string;
  /** 原 Config.APP_PLATFORM（管理端勾选；用户未预配置平台时随机选一提交） */
  appPlatforms: string[];
  /** 原 Config.APP_DESCRIPTION（APP 创建参数；用户经设置Description 预配置时优先使用） */
  appDescription: string;
  /** 原 Config.FOOTER_TEXT */
  footerText: string;
  /** 按语言文案覆盖（v2.1.7：texts.zh / texts.en；旧版扁平字符串键自动按 zh 迁移） */
  texts?: { zh?: Partial<TgApiBotTexts>; en?: Partial<TgApiBotTexts> };
  /**
   * v2.2.0 自定义键盘（ReplyKeyboard 对话流程）：配置非空 = 启用 @grammyjs/conversations
   * 驱动的自定义键盘工作流（主键盘 → 创建API（门禁 → 手机号 → 登录码 → 结果）等）；
   * 此时消息内嵌按钮不再渲染（互斥条件）。
   */
  customKeyboard?: CustomKeyboardConfig;
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

/** 文案覆盖字段的表单名 → TgApiBotTexts 键（管理后台按语言分组渲染/读取共用，全量可配置） */
export const TGAPI_TEXT_FIELD_KEYS = [
  { name: "start", label: "主键盘菜单消息（/start 与各操作后重新显示）" },
  { name: "unlockPrompt", label: "门禁提示（唯一门禁消息）" },
  { name: "askPhone", label: "手机号提示" },
  { name: "afterRecvdCode", label: "登录码提示" },
  { name: "beforeSuccLogin", label: "提交进度提示" },
  { name: "erredPage", label: "提交失败提示" },
  { name: "invalidCode", label: "登录码无效提示" },
  { name: "invalidPhone", label: "手机号无效提示" },
  { name: "askAppTitle", label: "设置Title 提示（{default} = 默认名称）" },
  { name: "askAppDescription", label: "设置Description 提示（{default} = 默认描述）" },
  { name: "helpText", label: "帮助回复" },
  { name: "supportText", label: "客服支持回复" },
  { name: "unknownInputHint", label: "未知输入提示" },
  { name: "askPlatform", label: "平台选择提示" },
  { name: "platformSet", label: "平台设置确认（{{platform}}）" },
  { name: "titleSet", label: "Title 设置确认（{{title}}）" },
  { name: "descriptionSet", label: "Description 设置确认（{{description}}）" },
  { name: "alreadyCreated", label: "已创建过提示（创建API）" },
  { name: "myApiEmpty", label: "尚未创建提示（我的API）" },
  { name: "myApiResult", label: "我的API 结果（{{phone}}/{{api_id}}/{{api_hash}}）" },
  { name: "contactAtMenu", label: "主菜单层收到联系人提示" },
  { name: "loginRejected", label: "登录被拒提示（{{error}}）" },
  { name: "shareContactLabel", label: "授权共享手机号按钮文案" },
  { name: "cancelLabel", label: "取消按钮文案" },
] as const;

const TEXT_KEY_SET = new Set<string>(TGAPI_TEXT_FIELD_KEYS.map((item) => item.name));

/**
 * tgapi 配置段规范化：把未知来源的对象（bots.config JSON 解析结果）收敛为
 * 带完整默认值的 TgApiBotConfig。parseTgApiBotConfig（字符串入口）与 multi-runtime
 * （对象入口）共用，保证运行实例与管理后台读到同一份默认值。
 */
export function normalizeTgApiSection(tgapi: unknown): TgApiBotConfig {
  if (typeof tgapi !== "object" || tgapi === null) {
    return { enabled: false, unlockMode: "captcha", ...TGAPI_DEFAULT_APP };
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
    // v2.2.0 自定义键盘（配置非空 = 自定义键盘对话流程，与内嵌按钮互斥）
    customKeyboard: parseCustomKeyboardConfig(cfg.customKeyboard) ?? undefined,
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
    return { enabled: false, unlockMode: "captcha", ...TGAPI_DEFAULT_APP };
  }
  if (typeof profile !== "object" || profile === null) {
    return { enabled: false, unlockMode: "captcha", ...TGAPI_DEFAULT_APP };
  }
  return normalizeTgApiSection((profile as { tgapi?: unknown }).tgapi);
}

/**
 * 组装某语言的对话文案：配置覆盖值（该语言）> 内置该语言默认文案
 *（v2.2.2 起全量字段，预填默认值；{{var}} 槽位在发送时按真实上下文渲染）。
 */
export function resolveTgApiTexts(cfg: TgApiBotConfig, lang: TgApiLang): TgApiBotTexts {
  const overrides = lang === "zh" ? cfg.texts?.zh : cfg.texts?.en;
  const builtin = lang === "zh" ? TGAPI_TEXTS_ZH : TGAPI_TEXTS_EN;
  const resolved = {} as TgApiBotTexts;
  for (const field of TGAPI_TEXT_FIELD_KEYS) {
    const key = field.name as keyof TgApiBotTexts;
    resolved[key] = overrides?.[key]?.trim() || builtin[key];
  }
  return resolved;
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
