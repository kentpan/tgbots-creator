import { NextResponse } from "next/server";
import { getCurrentAdmin } from "@/lib/auth";
import { isEdgeRuntime } from "@/lib/telegram/runtime-mode";
import { getAppSetting } from "@/database/operations";

/**
 * 运行时信息（v2.0.12 node 环境实操转发开关）：
 *
 * 本地 node 管理后台的「机器人测试」页面加载时先读本接口：
 * - runtime = "node" 且 remote_base_url 已配置 → 实操类请求（一键部署/加群申请/
 *   提交验证码/解析加群链接）由前端直接发往线上站点执行，本地不再直连 Telegram；
 * - runtime = "edge"（线上 Cloudflare Pages）或未配置线上站点 → 保持同源请求。
 */
export async function GET(): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }

  const remoteBaseUrl = (await getAppSetting("api.base_url"))?.trim() ?? "";

  return NextResponse.json({
    ok: true,
    runtime: isEdgeRuntime() ? "edge" : "node",
    remote_base_url: remoteBaseUrl || null,
  });
}
