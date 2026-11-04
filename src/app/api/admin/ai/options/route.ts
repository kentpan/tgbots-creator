import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission } from "@/lib/auth";
import { listAiModelOptions } from "@/services/ai-client";

/** AI 模型下拉浮层选项：第一项恒为 auto，其余按 provider 分组的模型列表 */
export async function GET(): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  if (!hasPermission(admin, "ai:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }
  const { options, defaultProviderId } = await listAiModelOptions();
  return NextResponse.json({ ok: true, data: { options, default_provider_id: defaultProviderId } });
}
