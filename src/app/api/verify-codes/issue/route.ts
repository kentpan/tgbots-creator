import { NextResponse } from "next/server";
import { createVerifyCode } from "@/database/xianyu-operations";
import { checkVerifyApiKey, generateOrderNo, generateVerifyCode } from "@/services/verify-codes";

/**
 * 测试验证码发码接口（开放 API，Bearer apikey 鉴权）。
 *
 * 作为「模拟发货」的目标 API 使用：发货成功后返回一条可用的加群验证码，
 * 该验证码可被 /api/verify-codes/verify 核验（与真实发卡/发货系统对接时，
 * 将发货 API URL 替换为业务系统地址即可，响应中包含 code/verify_code 字段均可被识别）。
 *
 *   POST /api/verify-codes/issue
 *   Authorization: Bearer <apikey>
 *   {"product_id": "xy_1001", "order_no": "XY2026...", "ttl_minutes": 30}
 *
 * 响应契约：{ "success": boolean, "msg": string, "data": object }
 */
export async function POST(request: Request): Promise<NextResponse> {
  const auth = await checkVerifyApiKey(request);
  if (!auth.ok) {
    // 鉴权失败 → HTTP 401（与验证接口文档契约一致）
    return NextResponse.json({ success: false, msg: auth.error, data: {} }, { status: 401 });
  }

  let payload: {
    product_id?: string | number;
    order_no?: string;
    ttl_minutes?: number;
    remark?: string;
  };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    payload = {};
  }

  try {
    const code = generateVerifyCode();
    const orderNo = String(payload.order_no ?? "").trim() || generateOrderNo();
    const ttlMinutes =
      typeof payload.ttl_minutes === "number" && payload.ttl_minutes > 0
        ? Math.min(Math.floor(payload.ttl_minutes), 24 * 60)
        : 30;
    const row = await createVerifyCode({
      code,
      productId: payload.product_id === undefined || payload.product_id === null ? null : String(payload.product_id),
      orderNo,
      ttlMinutes,
    });
    return NextResponse.json({
      success: true,
      msg: "发货成功：验证码已生成",
      data: {
        code: row.code,
        order_no: row.orderNo,
        product_id: payload.product_id ?? null,
        status: row.status,
        ttl_minutes: ttlMinutes,
        expires_at: row.expiresAt.toISOString(),
        verify_url: "/api/verify-codes/verify",
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("verify-codes/issue error:", detail);
    return NextResponse.json({ success: false, msg: `发码服务异常：${detail}`, data: {} });
  }
}
