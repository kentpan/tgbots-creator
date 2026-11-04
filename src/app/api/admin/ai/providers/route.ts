import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { getCurrentAdmin, hasPermission, logOperation } from "@/lib/auth";
import {
  createAiProvider,
  listAiProviders,
  serializeProvider,
} from "@/services/ai-config";

/** AI 提供方列表（分页 + 关键字） */
export async function GET(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  if (!hasPermission(admin, "ai:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }

  const url = new URL(request.url);
  const page = Number(url.searchParams.get("page") ?? "1");
  const pageSize = Number(url.searchParams.get("pageSize") ?? "10");
  const keyword = url.searchParams.get("keyword") ?? "";

  const result = await listAiProviders({ page, pageSize, keyword });
  return NextResponse.json({
    ok: true,
    data: {
      rows: result.rows.map((row) => serializeProvider(row)),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    },
  });
}

/** 创建 AI 提供方 */
export async function POST(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  if (!hasPermission(admin, "ai:manage")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
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

  const created = await createAiProvider({
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
  if (!created) return NextResponse.json({ ok: false, error: "创建失败" }, { status: 500 });

  const requestHeaders = await headers();
  await logOperation(admin, {
    action: "创建 AI 提供方",
    target: name,
    detail: `${baseUrl}（默认模型: ${String(payload.selected_model ?? "auto")}）`,
    headers: requestHeaders,
  });
  return NextResponse.json({ ok: true, data: serializeProvider(created) });
}
