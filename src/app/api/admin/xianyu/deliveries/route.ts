import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission } from "@/lib/auth";
import { listXianyuDeliveryLogs } from "@/database/xianyu-operations";

/** 发货日志查询（机器人测试页发货弹窗的历史日志区） */
export async function GET(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "bots:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }
  const url = new URL(request.url);
  const productRaw = url.searchParams.get("product_id");
  let productId: bigint | null = null;
  if (productRaw && /^\d+$/.test(productRaw)) {
    productId = BigInt(productRaw);
  }
  const logs = await listXianyuDeliveryLogs({ productId, limit: 20 });
  return NextResponse.json({
    ok: true,
    logs: logs.map((row) => ({
      id: String(row.id),
      productId: row.productId === null ? null : String(row.productId),
      apiUrl: row.apiUrl,
      requestMethod: row.requestMethod,
      requestHeaders: row.requestHeaders,
      requestBody: row.requestBody,
      responseStatus: row.responseStatus,
      responseBody: row.responseBody,
      durationMs: row.durationMs,
      verifyCode: row.verifyCode,
      success: row.success,
      error: row.error,
      createdTime: row.createdTime.toISOString(),
    })),
  });
}
