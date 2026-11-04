import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission, logOperation } from "@/lib/auth";
import { headers } from "next/headers";
import { upsertXianyuProduct, type XianyuProductRow } from "@/database/xianyu-operations";
import { fetchXianyuProducts } from "@/services/xianyu-client";

/**
 * 导入闲鱼商品：调用用户配置的商品 API（GET 参数附加 URL / POST JSON 请求体，默认 limit，可自定义参数名，
 * 均携带 Bearer apikey），归一化后落库 xianyu_products，并返回导入明细（含请求/响应日志，便于排查）。
 */
export async function POST(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "bots:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }

  let payload: { url?: string; api_key?: string; count?: number; param_name?: string; method?: string };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  let url = String(payload.url ?? "").trim();
  const apiKey = String(payload.api_key ?? "").trim();
  const count = Math.max(1, Math.min(Math.floor(Number(payload.count ?? 5)) || 5, 200));
  const method: "GET" | "POST" = payload.method === "POST" ? "POST" : "GET";
  const paramName = String(payload.param_name ?? "limit").trim() || "limit";

  // 用户可能省略协议头（如 d-deeb-xxx.fcapp.run/api/...），默认补全 https://
  if (url && !/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }

  if (!/^https?:\/\/\S+$/i.test(url)) {
    return NextResponse.json({ ok: false, error: "API 地址不合法（需 http/https）" }, { status: 400 });
  }
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "请填写 Bearer apikey" }, { status: 400 });
  }
  if (!/^[\w-]{1,64}$/.test(paramName)) {
    return NextResponse.json({ ok: false, error: "参数名不合法（仅支持字母/数字/下划线/短横线，最长 64 位）" }, { status: 400 });
  }

  const result = await fetchXianyuProducts({ url, apiKey, count, paramName, method });
  if (!result.ok) {
    return NextResponse.json({
      ok: false,
      error: result.error ?? "导入失败",
      log: { request: result.request, response: result.response },
    });
  }

  const saved: XianyuProductRow[] = [];
  let createdCount = 0;
  let updatedCount = 0;
  for (const product of result.products) {
    // 按 external_id 更新式导入：同 ID 商品刷新内容不重复插入
    const savedRow = await upsertXianyuProduct({
      externalId: product.externalId,
      title: product.title,
      price: product.price,
      description: product.description,
      imageUrl: product.imageUrl,
      sourceUrl: url,
      rawJson: JSON.stringify(product.raw),
    });
    if (savedRow) {
      saved.push(savedRow.row);
      if (savedRow.created) createdCount += 1;
      else updatedCount += 1;
    }
  }

  const requestHeaders = await headers();
  await logOperation(admin, {
    action: "导入闲鱼商品",
    target: url,
    detail: `拉取 ${result.products.length} 条：新建 ${createdCount}，更新 ${updatedCount}`,
    headers: requestHeaders,
  });

  return NextResponse.json({
    ok: true,
    imported: createdCount,
    updated: updatedCount,
    fetched: result.products.length,
    products: saved.map((row) => ({
      id: String(row.id),
      externalId: row.externalId,
      title: row.title,
      price: row.price,
      description: row.description,
      imageUrl: row.imageUrl,
      detailJson: row.detailJson,
      sourceUrl: row.sourceUrl,
      rawJson: row.rawJson,
      createdTime: row.createdTime.toISOString(),
    })),
    log: { request: result.request, response: result.response },
  });
}
