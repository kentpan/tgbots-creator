import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission, logOperation } from "@/lib/auth";
import { headers } from "next/headers";
import { getBot } from "@/database/operations";
import { deployBotAndReport, probeBotDeployState } from "@/services/bot-deploy";

/**
 * v2.1.11 仿真APP 统一部署入口（机器人级运行实例部署）：
 * TGAPI申请页列表「🚀 部署」已改为跳转本页 —— 全部机器人的上线/更新统一在
 * 仿真APP 页完成。实现复用 services/bot-deploy.ts 的唯一实现：
 * - POST：deployBotAndReport（重启运行实例 + 按生效传输模式取真实结果，
 *   webhook=setWebhook 注册结果 / polling=getMe 有界确认），失败绝不静默；
 * - GET：probeBotDeployState（webhook=Telegram getWebhookInfo 权威值 /
 *   polling=本进程运行实例权威值），供页面徽章展示与部署后同步。
 */

export async function POST(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "bots:manage")) {
    return NextResponse.json({ ok: false, error: "无权限（需要 bots:manage）" }, { status: 403 });
  }

  let payload: { bot_id?: string | number };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const botIdRaw = String(payload.bot_id ?? "").trim();
  if (!botIdRaw || !/^\d+$/.test(botIdRaw)) {
    return NextResponse.json({ ok: false, error: "机器人 ID 不合法" }, { status: 400 });
  }

  const bot = await getBot(BigInt(botIdRaw));
  if (!bot) {
    return NextResponse.json({ ok: false, error: "机器人不存在" }, { status: 404 });
  }

  const deploy = await deployBotAndReport(BigInt(botIdRaw), bot.enabled);
  await logOperation(admin, {
    action: "仿真APP部署机器人",
    target: bot.name,
    detail: deploy.message,
    headers: await headers(),
  });
  return NextResponse.json({ ok: true, state: deploy.state, message: deploy.message });
}

export async function GET(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "bots:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }
  const url = new URL(request.url);
  const botIdRaw = (url.searchParams.get("bot_id") ?? "").trim();
  if (!botIdRaw || !/^\d+$/.test(botIdRaw)) {
    return NextResponse.json({ ok: false, error: "机器人 ID 不合法" }, { status: 400 });
  }
  const bot = await getBot(BigInt(botIdRaw));
  if (!bot) {
    return NextResponse.json({ ok: false, error: "机器人不存在" }, { status: 404 });
  }
  const check = await probeBotDeployState(bot);
  return NextResponse.json({ ok: true, data: check });
}
