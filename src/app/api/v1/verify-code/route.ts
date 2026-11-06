import { NextResponse } from "next/server";
import {
  getVerificationSession,
  isSessionExpired,
} from "@/database/operations";
import { evaluateSubmittedCode, loadPendingContextByToken } from "@/services/verification-flow";

/**
 * 网页输码通道（v2.1.0，群内验证渠道的「人机验证 / 外部 API 卡密」实现）：
 *
 * 群内验证消息只放一个 URL 按钮（/verify?token=…），用户点开后在网页里输码 ——
 * 页面内容只有用户本人和机器人可见，其他群成员完全看不到输入内容，
 * 满足「群内验证但别人看不见验证码」的前提条件。
 *
 * 判定完全复用 evaluateSubmittedCode（与私聊输码、群内 4 选 1 按钮同一管道）：
 * 同一尝试次数控制、同一外部卡密 API、同一成功/失败文案与收口动作
 * （通过 → 落库批准 + 解禁 + 删除群内提示 + 群内欢迎；错误 3 次 → 计次→失效→rejected）。
 *
 * 身份校验：token 为 32 位加密随机串（不可猜测），验证链接本身即凭证；
 * 提交时使用会话里记录的 user_id 调外部校验接口，不信任请求体里的用户身份。
 */
export async function POST(request: Request): Promise<NextResponse> {
  let payload: { token?: unknown; code?: unknown };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json({ success: false, detail: "请求格式错误" }, { status: 422 });
  }

  const token = typeof payload.token === "string" ? payload.token.trim() : "";
  const code = typeof payload.code === "string" ? payload.code.trim() : "";
  if (!token || !code) {
    return NextResponse.json({ success: false, detail: "请输入验证码" }, { status: 422 });
  }

  try {
    const session = await getVerificationSession(token);
    if (!session) {
      return NextResponse.json(
        { success: false, detail: "验证链接无效，请重新申请加群" },
        { status: 404 },
      );
    }
    if (isSessionExpired(session)) {
      return NextResponse.json(
        { success: false, detail: "验证链接已过期，请重新申请加群" },
        { status: 400 },
      );
    }
    if (session.captchaCompleted) {
      return NextResponse.json({ success: true, detail: "您已完成验证，无需重复提交" });
    }
    if (session.method !== "code_api" && session.method !== "code_self") {
      return NextResponse.json(
        { success: false, detail: "当前验证方式不需要在网页输入验证码" },
        { status: 400 },
      );
    }

    const pending = await loadPendingContextByToken(token);
    if (!pending) {
      return NextResponse.json(
        { success: false, detail: "验证会话已失效，请重新申请加群" },
        { status: 400 },
      );
    }

    const result = await evaluateSubmittedCode({
      userId: session.userId,
      username: pending.joinRequest.username,
      code,
      preloaded: pending,
    });

    return NextResponse.json({
      success: result.outcome === "success",
      outcome: result.outcome,
      message: result.replyText,
      detail: result.replyText,
      reason: result.reason ?? null,
      remaining: result.remaining ?? null,
      network_error: result.networkError ?? false,
      approved: result.approved ?? false,
    });
  } catch (error) {
    console.error("[verify-code] 网页输码校验异常:", error);
    return NextResponse.json(
      { success: false, detail: "服务器内部错误，请稍后重试" },
      { status: 500 },
    );
  }
}
