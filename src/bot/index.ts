import { Bot } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { CommandGroup } from "@grammyjs/commands";
import type { BotContext } from "./context";
import { mainMenu } from "./menus";
import { handleJoinRequest, handleChatMemberUpdate } from "./handlers/chat-member";
import { handleCodeInput } from "./handlers/code-input";
import { handleVerificationChoice } from "./handlers/group-verification";
import { codeQuestion } from "./verification-question";
import { registerBuiltinCommandHandlers } from "./handlers/builtin-commands";
import { registerAiSupport, type AiSupportConfig } from "./handlers/ai-support";
import { buildSessionMiddleware } from "./session-storage";
import { listBotCommands } from "@/database/operations";
import { registerChatTracking } from "./chat-tracking";
import { telegramBotClientOptions } from "@/lib/telegram/transport";

export const BOT_COMMANDS = [
  { command: "start", description: "启动机器人" },
  { command: "help", description: "显示帮助信息" },
] as const;

/**
 * grammY 常用插件开关（bots.config.plugins，单项配置；缺省 = 开启官方推荐组合）：
 * - autoRetry：429 / 5xx 自动等待重试（auto-retry）
 * - throttler：发送限速排队（transformer-throttler，防 flood wait）
 */
export interface BotPluginsConfig {
  autoRetry?: boolean;
  throttler?: boolean;
  /** 会话存储单项覆盖：inherit / memory / sqlite / d1 / r2 / s3 */
  sessionStorage?: string;
}

export function parsePluginsConfig(raw: string): BotPluginsConfig {
  try {
    const parsed = JSON.parse(raw) as { plugins?: BotPluginsConfig };
    return parsed.plugins ?? {};
  } catch {
    return {};
  }
}

/** 应用 grammY 官方插件（API transformer 层，幂等） */
export function applyBotPlugins(bot: Bot<BotContext>, plugins: BotPluginsConfig): void {
  if (plugins.autoRetry !== false) {
    bot.api.config.use(autoRetry({ maxRetryAttempts: 2, maxDelaySeconds: 5 }));
  }
  if (plugins.throttler !== false) {
    bot.api.config.use(apiThrottler());
  }
}

/**
 * 注册自定义指令（来自管理后台「指令管理」的自定义指令库）。
 *
 * 隐私模式行为（privacyMode，默认开启）：
 * - 开启：指令仅按 Telegram 隐私模式允许的方式匹配——标准 `/` 前缀、仅消息开头、
 *   忽略 `/cmd@bot` 定向写法，保证机器人在隐私模式开启的群中可用。
 * - 关闭：宽松匹配——指令可出现在消息任意位置（matchOnlyAtStart: false）、
 *   支持定向写法 `/cmd@bot`（targetedCommands: optional），
 *   需要机器人关闭隐私模式后才实际收到这类消息。
 */
export async function registerCustomCommands(
  bot: Bot<BotContext>,
  privacyMode: boolean,
): Promise<void> {
  try {
    const library = await listBotCommands({ type: "custom", enabledOnly: true });
    if (library.rows.length === 0) {
      return;
    }
    const group = new CommandGroup<BotContext>({
      matchOnlyAtStart: !privacyMode,
      targetedCommands: privacyMode ? "ignored" : "optional",
    });
    for (const item of library.rows) {
      group.command(item.name, item.description, async (ctx) => {
        const intro = item.intro || item.description;
        await ctx.reply(`⌨️ /${item.name}\n\n${intro}`);
      });
    }
    bot.use(group);
    await group.setCommands(bot).catch((error: unknown) => {
      console.error("[bot] 自定义指令 setCommands 同步失败:", error);
    });
  } catch (error) {
    console.warn("Failed to register custom commands:", error);
  }
}

export async function createBot(
  token: string,
  options?: { privacyMode?: boolean; config?: string },
): Promise<Bot<BotContext>> {
  // apiRoot 统一走传输层（Node 出站代理由全局 fetch 补丁透明处理）
  const bot = new Bot<BotContext>(token, telegramBotClientOptions());
  const privacyMode = options?.privacyMode ?? true;

  // grammY 官方插件（auto-retry / throttler）与会话外部存储（SQLite/D1/R2）
  const plugins = parsePluginsConfig(options?.config ?? "{}");
  applyBotPlugins(bot, plugins);
  const { middleware: sessionMiddleware } = await buildSessionMiddleware(plugins.sessionStorage);
  bot.use(sessionMiddleware);

  bot.use(mainMenu);

  // stateless-question 中间件：识别「回复验证问题」的消息（隐私模式兼容验证）
  bot.use(codeQuestion.middleware());

  // 真实群组自动登记（v1.1.1 统一实现，与 multi-runtime 共用）：
  // my_chat_member / chat_join_request / 群消息兜底 → chat-registry（只补充群名，不覆盖验证配置）
  registerChatTracking(bot, token);

  bot.on("chat_join_request", handleJoinRequest);

  // 直连入群防线（v1.1.3）：普通邀请链接/被拉入群直接进来的成员 → 补验证，超时/失败踢出
  bot.on("chat_member", handleChatMemberUpdate);

  // 群内验证 4 选 1 点选回调（v2.0.5）：非本模块 callback 原样放行后续中间件（菜单等）
  bot.on("callback_query:data", handleVerificationChoice);

  bot.on("message:text", handleCodeInput);

  // 内置指令：按指令库启用状态注册真实处理器（start/help/menu/… 共 23 条；数据库不可用时回退官方四条）
  try {
    const builtinPage = await listBotCommands({ type: "builtin", enabledOnly: true });
    registerBuiltinCommandHandlers(
      bot,
      builtinPage.rows.map((row) => ({ name: row.name, intro: row.intro, description: row.description })),
    );
  } catch (error) {
    console.error("[bot] 读取内置指令库失败，回退官方四条（start/help/stats/api）:", error);
    registerBuiltinCommandHandlers(bot, [
      { name: "start" },
      { name: "help" },
      { name: "stats" },
      { name: "api" },
    ]);
  }

  void registerCustomCommands(bot, privacyMode);

  // AI 客服（配置在 bots.config.aiSupport；默认关闭，管理后台机器人表单可开启）
  try {
    const parsed = JSON.parse(options?.config ?? "{}") as { aiSupport?: AiSupportConfig };
    if (parsed.aiSupport?.enabled) {
      registerAiSupport(bot, parsed.aiSupport);
    }
  } catch (error) {
    console.error("[bot] 解析主 bot AI 客服配置失败:", error);
  }

  bot.catch((error) => {
    console.error("Bot error while handling update:", error.error);
  });

  return bot;
}
