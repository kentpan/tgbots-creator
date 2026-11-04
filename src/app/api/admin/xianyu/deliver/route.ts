import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission, logOperation } from "@/lib/auth";
import { headers } from "next/headers";
import { getXianyuProduct, createXianyuDeliveryLog, listXianyuDeliveryLogs } from "@/database/xianyu-operations";
import { deliverXianyuProduct } from "@/services/xianyu-client";

/**
 * 模拟发货：调用用户配置的发货 API（POST + Bearer apikey），
 * 返回完整请求/响应日志与提取出的测试加群验证码，并落库 xianyu_delivery_logs。
 */
export async function POST(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "bots:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }

  let payload: { product_id?: string | number; url?: string; api_key?: string };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const productId = BigInt(payload.product_id ?? 0);
  const url = String(payload.url ?? "").trim();
  const apiKey = String(payload.api_key ?? "").trim();

  if (!productId) {
    return NextResponse.json({ ok: false, error: "缺少商品 ID" }, { status: 400 });
  }
  if (!/^https?:\/\/\S+$/i.test(url)) {
    return NextResponse.json({ ok: false, error: "发货 API 地址不合法（需 http/https）" }, { status: 400 });
  }
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "请填写 Bearer apikey" }, { status: 400 });
  }

  const product = await getXianyuProduct(productId);
  if (!product) {
    return NextResponse.json({ ok: false, error: "商品不存在" }, { status: 404 });
  }

  const result = await deliverXianyuProduct({
    url,
    apiKey,
    product: {
      externalId: product.externalId,
      productId: product.id,
      title: product.title,
      price: product.price,
    },
  });

  const log = await createXianyuDeliveryLog({
    productId: product.id,
    apiUrl: url,
    requestMethod: result.request.method,
    requestHeaders: JSON.stringify(result.request.headers),
    requestBody: result.request.body,
    responseStatus: result.response?.status ?? null,
    responseBody: result.response?.bodyText ?? null,
    durationMs: result.response?.durationMs ?? null,
    verifyCode: result.code,
    success: result.ok,
    error: result.error ?? null,
  });

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: result.error ?? "发货失败",
        code: result.code,
        request: result.request,
        response: result.response,
      },
      { status: 200 },
    );
  }

  const requestHeaders = await headers();
  await logOperation(admin, {
    action: "模拟发货",
    target: product.title,
    detail: `订单 ${result.code ? `已返回验证码 ${result.code}` : "未返回验证码"}`,
    headers: requestHeaders,
  });

  return NextResponse.json({
    ok: true,
    code: result.code,
    message: result.message,
    request: result.request,
    response: result.response,
  });
}
