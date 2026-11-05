import type { Bot } from "grammy";
import { createBot, BOT_COMMANDS } from "./index";
import type { BotContext } from "./context";
import { runCleanupLoop, CLEANUP_INTERVAL_SECONDS } from "./tasks";
import { POLLING_ALLOWED_UPDATES } from "@/lib/telegram/runtime-mode";
import { config } from "@/config/settings";
import {
  LONG_POLL_TIMEOUT_SECONDS,
  isPollingRestartable,
  runPollingWithAutoRestart,
} from "./polling-restart";

interface BotRuntime {
  bot: Bot<BotContext>;
}

const globalForRuntime = globalThis as unknown as {
  tguardBotRuntime?: BotRuntime;
  tguardCleanupAbort?: AbortController;
};

/**
 * 验证清理循环（v1.1.4 与主 bot 解耦）：
 * 此前清理循环在主 bot 启动之后才拉起 —— 主 bot token 未配置（本地/沙箱仅用菜单 bot）
 * 或传输模式为 webhook 时 startBotRuntime 提前 return，清理循环永远不会启动：
 * 过期会话无人处理，超时通知/拒绝申请/踢出未验证成员全部静默失效。
 * 现在只要进程启动就启动清理循环，且全局只启动一次。
 */
function startCleanupLoopOnce(): void {
  if (globalForRuntime.tguardCleanupAbort) {
    return;
  }
  const cleanupAbort = new AbortController();
  globalForRuntime.tguardCleanupAbort = cleanupAbort;
  void runCleanupLoop(CLEANUP_INTERVAL_SECONDS, cleanupAbort.signal).catch((error) => {
    console.error("Cleanup loop stopped with error:", error);
  });
}

export async function startBotRuntime(): Promise<void> {
  // v1.1.4：清理循环必须无条件运行（见 startCleanupLoopOnce 注释），先于主 bot token 检查
  startCleanupLoopOnce();

  if (globalForRuntime.tguardBotRuntime) {
    return;
  }

  if (!config.bot.token) {
    console.warn("Bot token is not configured; Telegram bot polling is disabled");
    return;
  }

  // 主 bot 传输模式（v2.0.2）：默认 Webhook（出站 API 走全局代理，入站由 Telegram
  // 推送到 /api/telegram/webhook/main）；Node 未配置 Webhook Base URL 时回退轮询
  const { getTelegramRuntimeSettings, applyBotTransport } = await import("@/services/bot-transport");
  const { resolveEffectiveTransportWithFallback, isEdgeRuntime } = await import("@/lib/telegram/runtime-mode");
  const globalSettings = await getTelegramRuntimeSettings();
  const mainMode = resolveEffectiveTransportWithFallback(
    "inherit",
    globalSettings.transportMode,
    isEdgeRuntime(),
    Boolean(globalSettings.webhookBaseUrl),
  );
  if (mainMode === "webhook") {
    const applied = await applyBotTransport(
      { token: config.bot.token, botId: "main" },
      "webhook",
      globalSettings.webhookBaseUrl,
    );
    console.log(
      `Main bot transport=webhook ${applied.ok ? "registered (/api/telegram/webhook/main)" : `register failed: ${applied.error ?? "?"}`}`,
    );
    return;
  }

  const bot = await createBot(config.bot.token);

  // 自愈：本应用为轮询消费模式，历史会话遗留的 webhook（如指向已失效的沙箱预览地址）
  // 会让 getUpdates 永久 409。启动前删除 webhook（不丢弃待处理更新，群事件照常入队）。
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: false });
  } catch {
    /* 无 webhook 或网络失败时忽略，轮询自身会按需重试 */
  }

  try {
    await bot.api.setMyCommands([...BOT_COMMANDS]);
    console.log("Bot commands menu set");
  } catch (error) {
    console.error("Failed to set bot commands:", error);
  }

  // grammY 官方「long polling 错误自动重启」生产模式（详见 ./polling-restart.ts，与
  // multi-runtime 同一实现）：bot.catch 只兜 update 处理错误，polling 致命错误
  // （getMe 初始化失败 / getUpdates 401/409 rethrow 等）从 bot.start() 的 Promise 抛出，
  // 官方文档要求调用方捕获，否则机器人永久停止。此处自动重启并完整记录每次错误
  // （绝不吞错），仅 401（token 永久无效）与运行时已被停止/替换时不重启。
  void runPollingWithAutoRestart(
    bot,
    {
      // 显式声明更新类型（v1.1.3）：确保 chat_member（直连入群防线）与
      // callback_query（菜单按钮）必定送达，不受同步操作遗留 allowed_updates 影响
      allowed_updates: [...POLLING_ALLOWED_UPDATES],
      // 长轮询窗口 8s < 传输层 getUpdates 35s / 普通 12s 超时，避免代理抖动中止长轮询
      timeout: LONG_POLL_TIMEOUT_SECONDS,
      onStart: (me) => {
        console.log(`Bot started successfully: @${me.username}`);
      },
    },
    {
      label: "Main bot",
      shouldContinue: (error) =>
        globalForRuntime.tguardBotRuntime?.bot === bot && isPollingRestartable(error),
      onExit: () => {
        if (globalForRuntime.tguardBotRuntime?.bot === bot) {
          globalForRuntime.tguardBotRuntime = undefined;
        }
      },
    },
  );

  globalForRuntime.tguardBotRuntime = { bot };
}

export async function stopBotRuntime(): Promise<void> {
  const runtime = globalForRuntime.tguardBotRuntime;
  globalForRuntime.tguardBotRuntime = undefined;

  const cleanupAbort = globalForRuntime.tguardCleanupAbort;
  globalForRuntime.tguardCleanupAbort = undefined;
  cleanupAbort?.abort();

  if (!runtime) {
    return;
  }

  try {
    await runtime.bot.stop();
  } catch (error) {
    console.warn("Bot stop error:", error);
  }
}
