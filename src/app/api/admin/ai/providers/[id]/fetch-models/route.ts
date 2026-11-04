import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { getCurrentAdmin, hasPermission, logOperation } from "@/lib/auth";
import { fetchProviderModels } from "@/services/ai-config";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** 拉取 AI 提供方支持的模型列表（GET {base_url}/models）并缓存 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
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

  // 允许在保存前用临时配置探测：body 里带 base_url / api_key 时优先使用
  let temp: { base_url?: string; api_key?: string } = {};
  try {
    temp = (await request.json()) as typeof temp;
  } catch {
    /* 空请求体 = 拉取已保存配置 */
  }

  if (temp.base_url) {
    const { fetchModelsDirect } = await import("@/services/ai-config");
    const result = await fetchModelsDirect(temp.base_url, temp.api_key ?? "");
    return NextResponse.json({ ok: result.ok, data: { models: result.models }, error: result.error });
  }

  const result = await fetchProviderModels(providerId);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error ?? "拉取失败" });
  }
  const requestHeaders = await headers();
  await logOperation(admin, {
    action: "拉取 AI 模型列表",
    target: `#${id}`,
    detail: `获取到 ${result.models.length} 个模型`,
    headers: requestHeaders,
  });
  return NextResponse.json({ ok: true, data: { models: result.models } });
}
