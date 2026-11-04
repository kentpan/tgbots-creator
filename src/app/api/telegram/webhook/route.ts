import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { config } from "@/config/settings";
import { createBot } from "@/bot";

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
    return NextResponse.json({ detail: "Bot token 未配置" }, { status: 503 });
  }

  if (!verifyWebhookSecret(request)) {
    return NextResponse.json({ detail: "Webhook 密钥校验失败" }, { status: 401 });
  }

  let update: unknown;
  try {
    update = await request.json();
  } catch {
    return NextResponse.json({ detail: "请求格式错误" }, { status: 422 });
  }

  if (!globalForWebhook.botGroupsWebhookBot) {
    globalForWebhook.botGroupsWebhookBot = await createBot(config.bot.token);
  }
  const bot = globalForWebhook.botGroupsWebhookBot;

  try {
    await bot.handleUpdate(update as Parameters<typeof bot.handleUpdate>[0]);
  } catch (error) {
    console.error("Error handling Telegram update:", error);
  }

  return NextResponse.json({ ok: true });
}
