/**
 * 机器人默认文案唯一注册表（v3.0.2 文案配置中心）：
 *
 * 铁律：机器人发送的所有默认消息文案都必须可编辑（管理端「功能配置 → 默认文案」），
 * 本文件的常量只作为「默认值 + 文本框回填源」，绝不作为运行时唯一来源。
 *
 * - BOT_TEXT_DEFS：文案项清单（key/标签/默认值/说明），驱动管理端文本框自动生成，
 *   文本框默认回填当前生效值（bots.config.texts[key] ?? 默认值）。
 *   标题必须写清「哪条指令/哪个场景」，说明必须写清「什么时候发给谁」。
 * - resolveBotTexts(config)：合并 bots.config.texts 与默认值，产出运行时文案表，
 *   multi-runtime 注入 ctx.botTexts，各 handler 统一从 ctx.botTexts 取值。
 * - 约定：文案值为空字符串 = 该条消息不发送（handler 必须判空跳过）。
 */

export interface BotTextDef {
  key: string;
  label: string;
  defaultValue: string;
  description: string;
}

/** /start 欢迎文案默认值（纯文本；历史 MarkdownV2 常量退役，避免双源） */
export const DEFAULT_START_WELCOME_TEXT = [
  "🤖 TGuard 群组验证机器人",
  "",
  "🛡️ 自动验证新成员身份，防止机器人和恶意用户进入群组",
  "",
  "功能：",
  "• 新成员申请加群时自动发送验证链接",
  "• 通过人机验证后自动批准加群",
  "• 支持多种验证码服务(hCaptcha、Cap.js、Turnstile)",
  "",
  "使用 /help 查看更多信息",
  "",
  "👇 也可以直接点击下方菜单按钮：",
].join("\n");

export const DEFAULT_HELP_TEXT = [
  "🤖 TGuard 群组验证机器人",
  "",
  "🛡️ 自动验证新成员身份，防止机器人和恶意用户进入群组",
  "",
  "使用说明：",
  "如何使用请见 README（https://github.com/SideCloudGroup/TGuard）",
  "",
  "技术支持：",
  "由 TGuard（https://github.com/SideCloudGroup/TGuard）提供技术支持",
].join("\n");

/**
 * 群组「提示文案」产品默认值（v3.0.3 合并输码引导 —— 用户要求完整消息默认回填在
 * 群组信息文本框中编辑）。运行时把该文案整条发送，不再额外拼接引导句。
 * 旧默认值「🔐 请回复本消息并输入验证码完成验证」在读取时归一为 NULL（mapGroupSettings），
 * 老群组自动升级为新默认，用户无感。
 */
export const DEFAULT_GROUP_PROMPT_TEXT = [
  "🔐 请输入验证码完成验证",
  "",
  "请直接在下方输入框发送验证码，无需回复本消息。",
].join("\n");

/** 群组提示文案的历史默认值（读取时归一为 NULL 的迁移哨兵） */
export const LEGACY_GROUP_PROMPT_TEXT = "🔐 请回复本消息并输入验证码完成验证";

/** 机器人文案清单：管理端「默认文案配置」区块按此渲染，全部默认回填 */
export const BOT_TEXT_DEFS: BotTextDef[] = [
  {
    key: "start_welcome",
    label: "/start 欢迎消息（用户首次打开机器人时回复）",
    defaultValue: DEFAULT_START_WELCOME_TEXT,
    description:
      "场景：用户在 Telegram 打开与机器人的私聊、发送 /start（或点「启动」按钮）时的第一段回复。支持换行与变量 {{bot_name}}、{{bot_username}}、{{chat_title}}；置空 = /start 不发欢迎文本（内嵌菜单开启时仍会发菜单提示）。",
  },
  {
    key: "start_no_menu",
    label: "/start 回复（「消息内嵌按钮」面板关闭时）",
    defaultValue: "🤖 TGuard 机器人\n\n发送 /help 查看可用指令。",
    description:
      "场景：机器人「功能配置 → 菜单与键盘」的内嵌按钮面板被关闭时，用户发 /start 的纯文本回复。置空 = 该场景 /start 不回复文本。",
  },
  {
    key: "start_keyboard",
    label: "/start 回复（自定义键盘模式时）",
    defaultValue: "🤖 TGuard 机器人\n\n👇 请使用下方自定义键盘按钮：",
    description:
      "场景：界面模式为「自定义键盘」时，用户发 /start 的回复文案，消息底部附带自定义键盘。置空 = 只发键盘不发文本。",
  },
  {
    key: "menu_hint",
    label: "/menu 菜单提示（点击菜单按钮 / 发送 /menu 时）",
    defaultValue: "👇 请通过下方菜单按钮继续操作：",
    description:
      "场景：用户发送 /menu 指令或点击「菜单」按钮时回复的提示语，消息底部附带内嵌按钮菜单；「消息内嵌按钮」面板关闭时本条整体不发送。置空 = 只发菜单不发提示语。",
  },
  {
    key: "help_text",
    label: "/help 帮助说明（用户发送 /help 时回复）",
    defaultValue: DEFAULT_HELP_TEXT,
    description:
      "场景：用户发送 /help 或点击「帮助」菜单项时回复的整段使用说明。置空 = /help 不回复。",
  },
  {
    key: "dm_join_prompt",
    label: "入群申请私聊提示（用户点击「申请加入群组」后机器人私聊发送）",
    defaultValue: "✅ 已收到你的入群申请，请直接在此发送验证码完成验证。",
    description:
      "场景：用户通过邀请链接/深链提交加群申请（chat_join_request）后，机器人在与该用户的私聊中发送的引导语 —— 用户就地直接发送验证码即可完成验证（外部卡密验证）。支持变量 {{bot_name}}、{{bot_username}}、{{chat_title}}。置空 = 申请后机器人不主动发任何私聊消息。",
  },
  {
    key: "attempts_exhausted",
    label: "验证次数用尽提示（私聊输码错误次数超上限时）",
    defaultValue: "超出验证次数, 请重新申请加入群组",
    description:
      "场景：用户私聊输码连续错误达到最大尝试次数（群组设置 max_attempts，默认 3 次），验证会话失效后机器人发送的最终提示。支持变量 {{bot_name}}、{{bot_username}}。置空 = 次数用尽时机器人不回复。",
  },
  {
    key: "dm_join_success",
    label: "审批通过私聊祝贺（加群申请被批准后机器人私聊发送）",
    defaultValue: "🎉 验证成功！您已成功加入 {{chat_title}}，欢迎！",
    description:
      "场景：加群申请被机器人自动批准（approveChatJoinRequest 成功）后，机器人在私聊发送的祝贺消息，附带「前往群组」跳转按钮。支持变量 {{bot_name}}、{{bot_username}}、{{chat_title}}。置空 = 不发送祝贺消息（按钮也随之不发送）。",
  },
];

/** 默认值速查表（运行时 fallback） */
export const BOT_TEXT_DEFAULTS: Record<string, string> = Object.fromEntries(
  BOT_TEXT_DEFS.map((def) => [def.key, def.defaultValue]),
);

/** 文案变量取值（v3.0.3：所有默认文案统一支持 {{bot_name}} / {{bot_username}} / {{chat_title}}） */
export interface BotTextVars {
  /** 机器人名称（运行时 = Telegram 侧 first_name；仿真屏 = 机器人配置名） */
  botName?: string | null;
  /** 机器人用户名（不含 @；空 = {{bot_username}} 替换为空串） */
  botUsername?: string | null;
  /** 当前群组名称（私聊场景为空） */
  chatTitle?: string | null;
}

/**
 * 文案变量插值（所有默认文案发送前统一调用）：
 *   {{bot_name}}      → 机器人名称（vars.botName 未提供 = 保留占位不替换；
 *                        提供但为空 = TGuard）
 *   {{bot_username}}  → @用户名（未提供 = 保留占位；提供但为空 = 替换为空串）
 *   {{chat_title}}    → 当前群组名称（未提供 = 保留占位；提供但为空 = 替换为空串）
 */
export function renderBotTextVars(text: string, vars: BotTextVars = {}): string {
  if (!text) return text;
  let out = text;
  if (vars.botName !== undefined) {
    out = out.replaceAll("{{bot_name}}", vars.botName?.trim() || "TGuard");
  }
  if (vars.botUsername !== undefined) {
    out = out.replaceAll("{{bot_username}}", vars.botUsername?.trim() ? `@${vars.botUsername.trim()}` : "");
  }
  if (vars.chatTitle !== undefined) {
    out = out.replaceAll("{{chat_title}}", vars.chatTitle?.trim() ?? "");
  }
  return out;
}

/**
 * 合并 bots.config.texts 与默认值 → 运行时文案表。
 * 显式空串 = 用户选择不发送该条消息（保留空串语义，不回落默认值）；
 * undefined/缺失 = 未配置 → 使用默认值。
 */
export function resolveBotTexts(configTexts: unknown): Record<string, string> {
  const merged: Record<string, string> = { ...BOT_TEXT_DEFAULTS };
  if (configTexts && typeof configTexts === "object" && !Array.isArray(configTexts)) {
    for (const [key, value] of Object.entries(configTexts as Record<string, unknown>)) {
      if (typeof value === "string") merged[key] = value;
    }
  }
  return merged;
}
