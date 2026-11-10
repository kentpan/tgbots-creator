import { timingSafeEqual } from "@/utils/crypto";
import { NextResponse } from "next/server";
import { config } from "@/config/settings";
import { createBot } from "@/bot";
import { logWebhookRejected, logWebhookUpdate } from "@/lib/telegram/webhook-log";

const globalForWebhook = globalThis as unknown as {
  botGroupsWebhookBot?: Awaited<ReturnType<typeof createBot>>;
};

function verifyWebhookSecret(request: Request): boolean {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return true;
  const provided = request.headers.get("x-telegram-bot-api-secret-token");
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  if (!config.bot.token) {
    logWebhookRejected("main", 503, "主 Bot Token 未配置");
    return NextResponse.json({ detail: "Bot token 未配置" }, { status: 503 });
  }

  if (!verifyWebhookSecret(request)) {
    logWebhookRejected("main", 401, "Webhook 密钥校验失败");
    return NextResponse.json({ detail: "Webhook 密钥校验失败" }, { status: 401 });
  }

  let update: unknown;
  try {
    update = await request.json();
  } catch {
    logWebhookRejected("main", 422, "请求格式错误（非 JSON）");
    return NextResponse.json({ detail: "请求格式错误" }, { status: 422 });
  }

  if (!globalForWebhook.botGroupsWebhookBot) {
    globalForWebhook.botGroupsWebhookBot = await createBot(config.bot.token);
  }
  const bot = globalForWebhook.botGroupsWebhookBot;

  const startedAt = Date.now();
  try {
    await bot.handleUpdate(update as Parameters<typeof bot.handleUpdate>[0]);
  } catch (error) {
    console.error("Error handling Telegram update:", error);
    logWebhookUpdate({
      botId: "main",
      botLabel: bot.botInfo.username ?? null,
      update,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({ ok: true });
  }
  logWebhookUpdate({
    botId: "main",
    botLabel: bot.botInfo.username ?? null,
    update,
    ok: true,
    durationMs: Date.now() - startedAt,
  });
  return NextResponse.json({ ok: true });
}
