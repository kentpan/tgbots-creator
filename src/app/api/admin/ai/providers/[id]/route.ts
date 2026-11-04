import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { getCurrentAdmin, hasPermission, logOperation } from "@/lib/auth";
import {
  deleteAiProvider,
  getAiProvider,
  promoteDefaultProvider,
  resetAiRateWindow,
  serializeProvider,
  updateAiProvider,
} from "@/services/ai-config";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** 更新 AI 提供方 */
export async function PUT(request: Request, context: RouteContext): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  if (!hasPermission(admin, "ai:manage")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }

  const { id } = await context.params;
  let providerId: bigint;
  try {
    providerId = BigInt(id);
  } catch {
    return NextResponse.json({ ok: false, error: "ID 不合法" }, { status: 400 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const name = String(payload.name ?? "").trim();
  const baseUrl = String(payload.base_url ?? "").trim();
  if (!name) return NextResponse.json({ ok: false, error: "名称不能为空" }, { status: 400 });
  if (!/^https?:\/\//i.test(baseUrl)) {
    return NextResponse.json({ ok: false, error: "Base URL 必须以 http:// 或 https:// 开头" }, { status: 400 });
  }

  const updated = await updateAiProvider(providerId, {
    name,
    baseUrl,
    apiKey: String(payload.api_key ?? ""),
    selectedModel: String(payload.selected_model ?? "auto"),
    rateLimitEnabled: payload.rate_limit_enabled === true,
    rateLimitMax: Number(payload.rate_limit_max ?? 60),
    rateLimitWindow: Number(payload.rate_limit_window ?? 60),
    isDefault: payload.is_default === true,
    enabled: payload.enabled !== false,
    remark: String(payload.remark ?? ""),
  });
  if (!updated) return NextResponse.json({ ok: false, error: "AI 提供方不存在" }, { status: 404 });
  if (payload.is_default === true) await promoteDefaultProvider(providerId);
  resetAiRateWindow(providerId);

  const requestHeaders = await headers();
  await logOperation(admin, {
    action: "更新 AI 提供方",
    target: name,
    detail: `${baseUrl}（模型: ${String(payload.selected_model ?? "auto")}）`,
    headers: requestHeaders,
  });
  return NextResponse.json({ ok: true, data: serializeProvider(updated) });
}

/** 删除 AI 提供方 */
export async function DELETE(_request: Request, context: RouteContext): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  if (!hasPermission(admin, "ai:manage")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }

  const { id } = await context.params;
  let providerId: bigint;
  try {
    providerId = BigInt(id);
  } catch {
    return NextResponse.json({ ok: false, error: "ID 不合法" }, { status: 400 });
  }

  const existing = await getAiProvider(providerId);
  if (!existing) return NextResponse.json({ ok: false, error: "AI 提供方不存在" }, { status: 404 });

  const deleted = await deleteAiProvider(providerId);
  const requestHeaders = await headers();
  await logOperation(admin, {
    action: "删除 AI 提供方",
    target: existing.name,
    detail: deleted ? existing.baseUrl : "删除失败",
    headers: requestHeaders,
  });
  return NextResponse.json({ ok: deleted });
}
