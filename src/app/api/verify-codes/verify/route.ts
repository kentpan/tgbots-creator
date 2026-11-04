import { NextResponse } from "next/server";
import { consumeVerifyCode } from "@/database/xianyu-operations";
import { checkVerifyApiKey } from "@/services/verify-codes";

/**
 * 外部验证码核验接口（开放 API，Bearer apikey 鉴权）。
 *
 * 供 TGuard「外部 API 验证方式」调用（code_api），也可由第三方业务系统直接调用：
 *   POST /api/verify-codes/verify
 *   Authorization: Bearer <apikey>
 *   { "code": "ABCD2345" }    ← 买家收到的卡密（兼容字段名: code / card / key）
 *
 * 响应契约：{ "success": boolean, "msg": string, "data": object }
 * 鉴权失败（缺少/无效 API Key）→ HTTP 401；验证失败（含卡密不存在/已使用）→ HTTP 200 + success=false
 */
export async function POST(request: Request): Promise<NextResponse> {
  const auth = await checkVerifyApiKey(request);
  if (!auth.ok) {
    return NextResponse.json({ success: false, msg: auth.error, data: {} }, { status: 401 });
  }

  let payload: {
    user_id?: number | string;
    code?: string;
    card?: string;
    key?: string;
    chat_id?: number | string;
    username?: string;
  };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json({ success: false, msg: "请求体不是合法 JSON", data: {} });
  }

  // 卡密字段兼容：code / card / key（与发卡平台验证接口文档一致）
  const code = String(payload.code ?? payload.card ?? payload.key ?? "").trim();
  if (!code) {
    return NextResponse.json({ success: false, msg: "缺少验证码 code 字段", data: { valid: false } });
  }

  const parseBig = (value: unknown): bigint | null => {
    if (value === undefined || value === null || value === "") return null;
    try {
      return BigInt(value as string | number);
    } catch {
      return null;
    }
  };

  try {
    const result = await consumeVerifyCode(code, {
      userId: parseBig(payload.user_id),
      chatId: parseBig(payload.chat_id),
    });
    if (!result.valid) {
      return NextResponse.json({
        success: false,
        msg: result.reason ?? "验证码校验未通过",
        data: { valid: false, code },
      });
    }
    return NextResponse.json({
      success: true,
      msg: "验证通过",
      data: {
        valid: true,
        code,
        order_no: result.row?.orderNo ?? null,
        product_id:
          result.row?.productId !== undefined && result.row?.productId !== null
            ? String(result.row.productId)
            : null,
        used_at: new Date().toISOString(),
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("verify-codes/verify error:", detail);
    return NextResponse.json({ success: false, msg: `验证服务异常：${detail}`, data: { valid: false } });
  }
}
