/**
 * 机器人运行实例部署与真实状态探测（v2.1.10 整合模块）。
 *
 * 历史背景：v2.1.9 把「部署/保存分离」实现为 TGAPI 页面的孤立动作
 * （tgapi/actions.ts deployTgApiBotAndReport + tgapi/page.tsx probeTgApiBotDeployState）。
 * 评审确认：TGAPI 机器人与普通机器人完全同架构（同一 bots 表、同一 multi-runtime
 * 进程内多实例、同一 webhook 路由），部署与状态探测是所有机器人共有的通用能力，
 * 不应只挂在 TGAPI 页面。本模块把两条实现收敛为唯一实现：
 *
 * - deployBotAndReport：显式部署（restartMenuBot）+ 按生效传输模式取真实结果
 *   （webhook=setWebhook 注册结果 / polling=getMe 有界确认），失败绝不静默；
 * - probeBotDeployState：真实部署状态探测
 *   （webhook=Telegram 侧 getWebhookInfo 权威值，含投递错误/积压；
 *    polling=本进程运行实例权威值）。
 *
 * 调用方：机器人管理页（bots/actions.ts deployBotAction + 列表部署状态列）
 * 与 TGAPI 申请页（tgapi/actions.ts / tgapi/page.tsx）—— 两个入口一个实现。
 */

import {
  getBot,
  type BotRow,
} from "@/database/operations";
import { tgRawCall } from "@/lib/telegram/transport";
import { withTelegramTimeout } from "@/services/telegram-sync";
import { getTelegramRuntimeSettings, resolveBotRuntime } from "@/services/bot-transport";
import {
  getMenuBotDeployState,
  restartMenuBot,
  waitForMenuBotDeployConfirmation,
} from "@/bot/multi-runtime";

/** 部署结果（真实结果，非预期值）——成功/失败/确认中，message 为给管理员的原文 */
export interface BotDeployOutcome {
  state: "ok" | "fail" | "pending" | "stopped";
  message: string;
}

const DEPLOY_CONFIRM_TIMEOUT_MS = 12000;

export function truncateDeployMessage(message: string): string {
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

/**
 * 显式部署机器人并取真实结果（await 运行实例重启，不再 fire-and-forget）：
 * - webhook：setWebhook 注册结果（startMenuBot 返回时已定）
 * - polling：有界等待 getMe 确认（onStart）/ 失败退出（onExit），超时如实报 pending
 * 部署失败绝不静默：原因原样返回给调用方回显。
 * 唯一实现（v2.1.10 整合）：机器人管理页「🚀 部署」与 TGAPI 页「🚀 部署」共用。
 */
export async function deployBotAndReport(botId: bigint, enabled: boolean): Promise<BotDeployOutcome> {
  if (!enabled) {
    return { state: "stopped", message: "机器人已停用，运行实例已停止" };
  }
  try {
    await restartMenuBot(botId);
  } catch (error) {
    console.error(`[bot-deploy] 机器人 #${String(botId)} 部署（重启运行实例）失败:`, error);
    return {
      state: "fail",
      message: truncateDeployMessage(error instanceof Error ? error.message : String(error)),
    };
  }
  await waitForMenuBotDeployConfirmation(botId, DEPLOY_CONFIRM_TIMEOUT_MS);
  const row = await getBot(botId);
  if (!row) {
    return { state: "fail", message: "部署失败：机器人记录不存在" };
  }
  const global = await getTelegramRuntimeSettings();
  const runtime = resolveBotRuntime(String(botId), row.config, global);
  const state = getMenuBotDeployState(botId);
  if (runtime.mode === "webhook") {
    if (state.transportOk === true) {
      return { state: "ok", message: `部署成功：Webhook 已注册（${state.transportUrl ?? "回调地址已生效"}）` };
    }
    if (state.transportOk === false) {
      return { state: "fail", message: `部署失败：${truncateDeployMessage(state.transportError ?? "Webhook 注册失败")}` };
    }
    return { state: "pending", message: "部署确认中：Webhook 注册尚未返回，请稍后刷新本页查看部署状态" };
  }
  if (state.started) {
    return { state: "ok", message: `部署成功：长轮询运行中（${state.transportUrl ?? "已连接 Telegram"}）` };
  }
  if (!state.running) {
    return {
      state: "fail",
      message: `部署失败：${truncateDeployMessage(state.startError ?? state.transportError ?? "轮询未启动，详见服务器日志")}`,
    };
  }
  return { state: "pending", message: "部署确认中：长轮询启动尚未确认，请稍后刷新本页查看部署状态" };
}

/** 真实部署状态（webhook=Telegram 侧 getWebhookInfo 权威值；polling=本进程运行实例权威值） */
export type BotDeployCheck =
  | { key: "disabled" }
  | { key: "deployed"; detail: string }
  | { key: "undeployed" }
  | { key: "mismatch"; detail: string }
  | { key: "deploying" }
  | { key: "delivery-error"; detail: string }
  | { key: "unknown"; detail: string };

/**
 * 逐机器人探测真实部署状态：
 * - webhook 模式：Telegram 侧 getWebhookInfo（跨 isolate/跨环境权威，不依赖本进程内存）。
 *   v2.1.9 黑盒治理：除回调地址外同时读取 Telegram 自己报告的投递结果 ——
 *   last_error_message（最近一次推送失败原话）/ pending_update_count（积压条数）。
 *   「已注册但消息根本进不来」的线上静默故障（如回调 401、超时）直接在列表亮红牌。
 * - polling 模式：本进程运行实例状态（长轮询只存在于本进程，内存即权威）
 * 探测失败/指向异常都如实展示，绝不兜底成“已部署”。
 */
export async function probeBotDeployState(bot: Pick<BotRow, "id" | "enabled" | "config" | "token">): Promise<BotDeployCheck> {
  if (!bot.enabled) return { key: "disabled" };
  const global = await getTelegramRuntimeSettings();
  const runtime = resolveBotRuntime(String(bot.id), bot.config, global);
  if (runtime.mode === "webhook") {
    try {
      const res = await withTelegramTimeout(
        tgRawCall<{
          ok: boolean;
          description?: string;
          result?: {
            url?: string;
            last_error_message?: string;
            last_error_date?: number;
            pending_update_count?: number;
          };
        }>(bot.token, "getWebhookInfo"),
      );
      if (!res.ok) {
        return { key: "unknown", detail: res.description ?? "Telegram API 返回错误" };
      }
      const url = (res.result?.url ?? "").trim();
      const lastError = (res.result?.last_error_message ?? "").trim();
      const pending = res.result?.pending_update_count ?? 0;
      const deliverySuffix = lastError
        ? `；Telegram 投递错误：${lastError}${pending > 0 ? `（积压 ${pending} 条未投递）` : ""}`
        : pending > 0
          ? `；积压 ${pending} 条待投递`
          : "";
      if (!url) return { key: "undeployed" };
      if (runtime.webhookUrl && url !== runtime.webhookUrl) {
        return { key: "mismatch", detail: `${url}${deliverySuffix}` };
      }
      // Webhook 已注册且指向正确，但 Telegram 自己报告过投递失败 =
      // 消息根本进不来 / 回复发不出去 —— 线上「静默」的最常见根因，原话展示
      if (lastError) {
        return {
          key: "delivery-error",
          detail: `Webhook 已注册但 Telegram 投递失败：${lastError}${pending > 0 ? `（积压 ${pending} 条未投递）` : ""}`,
        };
      }
      return { key: "deployed", detail: `Webhook${deliverySuffix}` };
    } catch (error) {
      return {
        key: "unknown",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const state = getMenuBotDeployState(bot.id);
  if (state.present && state.started) {
    return { key: "deployed", detail: `长轮询${state.transportUrl ?? ""}` };
  }
  if (state.present && state.running) return { key: "deploying" };
  return { key: "undeployed" };
}
