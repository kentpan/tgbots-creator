import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission } from "@/lib/auth";
import { listDeveloperAccounts } from "@/database/operations";

/**
 * 开发者账号配置状态（v3.0.3，轻量探测）：
 * 邀请链接面板用 —— MTProto 用户 API（Telethon/GramJS）导出群主邀请链接需要
 * api_id/api_hash（开发者账号）；Bot API（grammY）没有枚举/导出邀请链接的能力。
 * GET → { ok, data: { configured, count } }
 */
export async function GET(): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "bots:view") && !hasPermission(admin, "groups:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }
  try {
    const accounts = await listDeveloperAccounts();
    return NextResponse.json({
      ok: true,
      data: { configured: accounts.length > 0, count: accounts.length },
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "读取开发者账号失败" },
      { status: 500 },
    );
  }
}
