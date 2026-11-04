/**
 * grammY 官方「long polling 错误自动重启」生产模式（权威依据，不属自研轮子）：
 *
 * 1. grammY 官方文档《Error Handling》https://grammy.dev/guide/errors：
 *    "If you run your bot via bot.start() ... you should install an error handler via
 *    bot.catch. grammY has a default error handler installed that stops the bot if it
 *    was started by bot.start(). It then re-throws the error." —— bot.catch 只兜
 *    update 处理错误；polling 循环自身的致命错误（初始化 getMe 失败、getUpdates 的
 *    401/409 等，grammY 1.46 源码 handlePollingError 对 unauthorized/conflict 直接
 *    rethrow）会从 bot.start() 返回的 Promise 抛出。
 * 2. bot.start() 官方 JSDoc（grammy/out/bot.ts）："You don't need to `await` the call
 *    to `bot.start`, but remember to catch potential errors ... Otherwise your bot
 *    will crash (and stop) if something goes wrong in your code." —— 即调用方必须
 *    处理 start() 的 rejection，否则机器人停止后无人恢复。
 * 3. 官方插件 @grammyjs/runner 的文档语义即「source 失败后自动重启轮询」；本模块在
 *    bot.start() 外层实现同一语义的带间隔重启循环（不引入新依赖，不动 handler）。
 *
 * 原则：绝不吞错 —— 每次失败都 console.error 记录完整错误后再重启；
 * 仅 401 Unauthorized 不重启（token 永久无效，与 grammY 自身「rethrow upon
 * unauthorized」语义一致，重启只会无意义地持续请求 Telegram）。
 */
import { GrammyError } from "grammy";
import type { Bot } from "grammy";
import type { BotContext } from "./context";

/** 重启间隔：与 grammY 内部 handlePollingError 的重试间隔（3 秒）一致 */
const POLLING_RESTART_DELAY_MS = 3000;

/**
 * getUpdates 服务端轮询窗口（秒），经 bot.start({ timeout }) 传给 Telegram。
 * 取 0（短轮询，Telegram Bot API 官方合法参数，立即返回不持连接）：
 * 沙盒/中转代理实测无法承载持连接长轮询——timeout=1/3 的请求在代理侧随机挂死
 * 25s+，timeout=5/8 也要 6~17s 才返回（2026-11-03 dev.log 与 curl 实录），导致
 * grammY 的 getUpdates 大量在代理侧夭折、Telegram 侧长时间无消费者（手动
 * getUpdates 连续返回 200 空列表而非 409）。短轮询请求秒发秒回，与 getMe 同形，
 * 实测稳定；grammY 会以最小间隔连续循环 getUpdates，加群申请延迟仅数秒。
 */
export const LONG_POLL_TIMEOUT_SECONDS = 0;

/** grammY 语义：401 = token 永久无效，重启无意义；其余错误（网络抖动 / 409 / 5xx 等）可重启 */
export function isPollingRestartable(error: unknown): boolean {
  return !(error instanceof GrammyError && error.error_code === 401);
}

export interface PollingAutoRestartOptions {
  /** 日志前缀（如 `Menu bot #2` / `Main bot`），用于完整错误定位 */
  label: string;
  /**
   * 每次失败后决定是否继续重启（缺省 = 一直重启）。
   * 典型用途：实例已被 stopMenuBot / restartMenuBot / 同 token 去重替换时停止，
   * 交由新实例接管，避免新旧两个循环同时轮询同一 token。
   */
  shouldContinue?: (error: unknown) => boolean;
  /** 循环退出（受控停止或放弃重启）后的状态清理；仅实例仍注册时由调用方幂等清理 */
  onExit?: () => void;
}

/**
 * 以自动重启模式运行 grammY 长轮询（生产模式，永不 reject）：
 * - bot.start() 正常 resolve 仅发生在受控 bot.stop() 后 → 执行 onExit 并结束；
 * - start() reject（polling 致命错误）→ console.error 记录完整错误 → 间隔后重启。
 */
export async function runPollingWithAutoRestart(
  bot: Bot<BotContext>,
  startOptions: Parameters<Bot<BotContext>["start"]>[0],
  opts: PollingAutoRestartOptions,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await bot.start(startOptions);
      opts.onExit?.();
      return;
    } catch (error) {
      // 绝不吞错：完整记录错误详情（grammY 官方要求调用方捕获 start() 的错误，
      // 官方 runner 语义为失败后自动重启 source）
      console.error(
        `[${opts.label}] polling stopped with error (restart #${attempt}); ` +
          "auto-restarting per grammY official pattern:",
        error,
      );
      if (opts.shouldContinue && !opts.shouldContinue(error)) {
        opts.onExit?.();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, POLLING_RESTART_DELAY_MS));
    }
  }
}
