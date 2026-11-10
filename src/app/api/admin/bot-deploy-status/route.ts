import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission } from "@/lib/auth";
import { listBots } from "@/database/operations";
import { probeBotDeployState } from "@/services/bot-deploy";

/**
 * 机器人真实部署状态批量探测 API（v2.2.1）：
 *
 * SSR 页面只做数据层（DB 读取）与鉴权，部署状态探测（webhook 模式逐 bot 调
 * Telegram getWebhookInfo，跨网络往返）改为客户端挂载后异步拉取 ——
 * 页面首屏不再被逐 bot 网络探测阻塞（/admin/tgapi 响应时间优化的根因修复）。
 *
 * GET /api/admin/bot-deploy-status?ids=1,2,3
 * → { ok: true, checks: { "<botId>": BotDeployCheck } }
 */

export async function GET(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "tgapi:view") && !hasPermission(admin, "bots:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }

  const idsParam = new URL(request.url).searchParams.get("ids") ?? "";
  const ids = idsParam
    .split(",")
    .map((item) => item.trim())
    .filter((item) => /^\d+$/.test(item));
  if (ids.length === 0) {
    return NextResponse.json({ ok: true, checks: {} });
  }

  const bots = await listBots();
  const wanted = new Set(ids);
  const targets = bots.filter((bot) => wanted.has(String(bot.id)));
  // probeBotDeployState 自身兜底全部错误为 { key:"unknown", detail }（不抛出），逐 bot 并行探测
  const checks = await Promise.all(
    targets.map(async (bot) => [String(bot.id), await probeBotDeployState(bot)] as const),
  );
  return NextResponse.json({ ok: true, checks: Object.fromEntries(checks) });
}
