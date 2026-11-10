import { timingSafeEqual } from "@/utils/crypto";
import { NextResponse } from "next/server";
import { getBot, listEnabledBots } from "@/database/operations";
import { config } from "@/config/settings";
import { acquireMenuBot } from "@/bot/multi-runtime";
import { botWebhookSecret } from "@/lib/telegram/runtime-mode";
import { logWebhookRejected, logWebhookUpdate } from "@/lib/telegram/webhook-log";
import type { BotRow } from "@/database/operations";

/**
 * 按机器人 Webhook 回调入口：POST /api/telegram/webhook/<botId>
 * - botId = 数字 id：多机器人（bots 表），复用 acquireMenuBot（完整菜单/指令/验证能力）
 * - botId = "main"：config.toml 中的主 bot token
 *
 * 安全：校验 x-telegram-bot-api-secret-token 头与确定性派生密钥
 * （botWebhookSecret(botId, token)，注册 Webhook 时由 setWebhook 写入 Telegram）。
 *
 * v2.1.9 回调密钥自愈（2026-11-09「TGAPI 申请机器人线上彻底静默」事故根因修复）：
 * Telegram 侧注册的回调 URL 内嵌的是注册当时的 bots 行 id；数据库恢复/重建后同一
 * Token 的行 id 可能漂移（实测：Telegram 指向 /webhook/4，行已变成 id=5），旧路径
 * getBot(4) 查无此行 → 404 拒收 → 该机器人所有更新永久无人处理、毫无感知。
 * 修复：回调密钥本身就是「路径 id + Token」的确定性摘要 —— 路径 id 与当前行 id
 * 不一致（行不存在 / 行 Token 对不上密钥）时，用密钥对全部启用机器人的
 * botWebhookSecret(路径id, row.token) 做常数时间比对，反查出真实行并照常处理；
 * 同时打日志提示在管理后台点「部署」重新注册规范回调地址。密钥匹配要求持有
 * 确切 Token 才可能通过，不构成可枚举面；id 一致的正常机器人行为完全不变。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ botId: string }> },
): Promise<NextResponse> {
  const { botId } = await params;

  let token: string | null = null;
  if (botId === "main") {
    token = config.bot.token || null;
  } else if (/^\d+$/.test(botId)) {
    try {
      const row = await getBot(BigInt(botId));
      token = row?.token ?? null;
    } catch {
      token = null;
    }
  }

  const provided = request.headers.get("x-telegram-bot-api-secret-token");
  const providedBuf = Buffer.from(provided ?? "");

  /** 常数时间比对派生密钥与 Telegram 回调头（长度不等直接 false） */
  const secretMatches = (pathBotId: string, candidateToken: string): boolean => {
    const expected = Buffer.from(botWebhookSecret(pathBotId, candidateToken));
    if (expected.length !== providedBuf.length) return false;
    return timingSafeEqual(expected, providedBuf);
  };

  let matchedRow: BotRow | null = null;

  if (botId === "main") {
    if (!token) {
      logWebhookRejected(botId, 404, "主机器人 Token 未配置");
      return NextResponse.json({ detail: "主机器人 Token 未配置" }, { status: 404 });
    }
    if (!secretMatches(botId, token)) {
      logWebhookRejected(botId, 401, "Webhook 密钥校验失败");
      return NextResponse.json({ detail: "Webhook 密钥校验失败" }, { status: 401 });
    }
  } else if (/^\d+$/.test(botId)) {
    const directRow = await getBot(BigInt(botId)).catch(() => null);
    if (directRow && secretMatches(botId, directRow.token)) {
      // 常规路径：行 id 与回调 URL 一致且密钥匹配
      matchedRow = directRow;
    } else {
      // 自愈路径：行不存在（id 漂移）或行 Token 对不上密钥 —— 按密钥反查真实行
      // （仅启用中的机器人参与反查；密钥匹配要求持有确切 Token，不构成可枚举面）
      const candidates = await listEnabledBots().catch((error: unknown) => {
        console.error(`[webhook] 机器人 ${botId} 密钥自愈反查失败:`, error);
        return [];
      });
      matchedRow = candidates.find((row) => secretMatches(botId, row.token)) ?? null;
      if (matchedRow) {
        console.warn(
          `[webhook] 回调地址指向旧 id ${botId}，已按回调密钥自愈匹配到机器人 #${String(matchedRow.id)}` +
            `${matchedRow.username ? ` (@${matchedRow.username})` : ""} —— 请在管理后台对该机器人点「部署」重新注册规范回调地址。`,
        );
      }
    }
    if (!matchedRow) {
      const detail = directRow ? "Webhook 密钥校验失败" : "机器人不存在或 Token 未配置";
      logWebhookRejected(botId, directRow ? 401 : 404, detail);
      return NextResponse.json({ detail }, { status: directRow ? 401 : 404 });
    }
    token = matchedRow.token;
  } else {
    logWebhookRejected(botId, 404, "机器人不存在或 Token 未配置");
    return NextResponse.json({ detail: "机器人不存在或 Token 未配置" }, { status: 404 });
  }

  let update: unknown;
  try {
    update = await request.json();
  } catch {
    logWebhookRejected(botId, 422, "请求格式错误（非 JSON）");
    return NextResponse.json({ detail: "请求格式错误" }, { status: 422 });
  }

  const startedAt = Date.now();
  const botLabel = botId === "main" ? null : matchedRow?.username ?? matchedRow?.name ?? null;
  try {
    // grammY 官方 webhook 模式要求：handleUpdate 依赖 botInfo（如 @bot 定向指令匹配），
    // webhook 实例不经过 bot.start()，必须先 init()（幂等：已初始化则跳过 getMe）。
    // 否则服务器以 webhook 模式直接拉起的全新实例在处理首条更新时抛
    // “Bot not initialized”（2026-11-04 模拟签名回调实测命中）。
    if (botId === "main") {
      const { createBot } = await import("@/bot");
      const globalForWebhook = globalThis as unknown as {
        tguardMainWebhookBot?: Awaited<ReturnType<typeof createBot>>;
      };
      if (!globalForWebhook.tguardMainWebhookBot) {
        globalForWebhook.tguardMainWebhookBot = await createBot(token);
      }
      const mainBot = globalForWebhook.tguardMainWebhookBot;
      if (!mainBot.isInited()) await mainBot.init();
      await mainBot.handleUpdate(update as Parameters<typeof mainBot.handleUpdate>[0]);
    } else if (matchedRow) {
      // 自愈/常规路径统一按真实行 id 取实例（自愈时真实 id ≠ 路径 id）
      const handle = await acquireMenuBot(matchedRow.id);
      if (!handle) {
        logWebhookRejected(botId, 503, "机器人不可用（运行实例获取失败）");
        return NextResponse.json({ detail: "机器人不可用" }, { status: 503 });
      }
      if (!handle.bot.isInited()) await handle.bot.init();
      await handle.bot.handleUpdate(update as Parameters<typeof handle.bot.handleUpdate>[0]);
    }
  } catch (error) {
    console.error(`Error handling Telegram webhook update (bot=${botId}):`, error);
    logWebhookUpdate({
      botId,
      botLabel,
      update,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({ ok: true });
  }
  logWebhookUpdate({ botId, botLabel, update, ok: true, durationMs: Date.now() - startedAt });
  return NextResponse.json({ ok: true });
}
