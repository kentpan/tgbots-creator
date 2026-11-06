import { timingSafeEqual } from "@/utils/crypto";
import { NextResponse } from "next/server";
import { getBot } from "@/database/operations";
import { config } from "@/config/settings";
import { acquireMenuBot } from "@/bot/multi-runtime";
import { botWebhookSecret } from "@/lib/telegram/runtime-mode";
import { runHousekeepingIfDue } from "@/services/housekeeping";

/**
 * 按机器人 Webhook 回调入口：POST /api/telegram/webhook/<botId>
 * - botId = 数字 id：多机器人（bots 表），复用 acquireMenuBot（完整菜单/指令/验证能力）
 * - botId = "main"：config.toml 中的主 bot token
 *
 * 安全：校验 x-telegram-bot-api-secret-token 头与确定性派生密钥
 * （botWebhookSecret(botId, token)，注册 Webhook 时由 setWebhook 写入 Telegram）。
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
  if (!token) {
    return NextResponse.json({ detail: "机器人不存在或 Token 未配置" }, { status: 404 });
  }

  const expected = botWebhookSecret(botId, token);
  const provided = request.headers.get("x-telegram-bot-api-secret-token");
  const a = Buffer.from(expected);
  const b = Buffer.from(provided ?? "");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    // Telegram 侧配置的 secret 与本应用派生值不一致（典型：历史同步流程重建 Webhook 时
    // 漏传 secret_token）→ 本条更新被拒收，但 Telegram 会继续排队重试。
    // 管理端点一次「同步真实群组」会用派生密钥重建 Webhook 并把积压更新重放回来。
    console.error(
      `[webhook] 密钥校验失败 bot=${botId}：Telegram 未携带密钥或密钥不匹配${provided ? "" : "（请求头缺失）"}；` +
        "若持续出现，请在「机器人测试 → 同步真实群组」触发一次 Webhook 自愈重建",
    );
    return NextResponse.json({ detail: "Webhook 密钥校验失败" }, { status: 401 });
  }

  let update: unknown;
  try {
    update = await request.json();
  } catch {
    return NextResponse.json({ detail: "请求格式错误" }, { status: 422 });
  }

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
    } else {
      const handle = await acquireMenuBot(BigInt(botId));
      if (!handle) {
        return NextResponse.json({ detail: "机器人不可用" }, { status: 503 });
      }
      if (!handle.bot.isInited()) await handle.bot.init();
      await handle.bot.handleUpdate(update as Parameters<typeof handle.bot.handleUpdate>[0]);
    }
  } catch (error) {
    console.error(`Error handling Telegram webhook update (bot=${botId}):`, error);
  }

  // v2.2.0：边缘侧机会式归档（1 小时最多一次，未到期时零 IO 直接返回）。
  // 表体积是 D1 扫描行成本的第一放大器 —— 必须有人在 Cloudflare 上负责瘦身。
  try {
    await runHousekeepingIfDue();
  } catch (error) {
    console.warn("[webhook] housekeeping skipped:", error);
  }

  return NextResponse.json({ ok: true });
}
