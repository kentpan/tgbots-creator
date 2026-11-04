import { NextResponse, type NextRequest } from "next/server";
import { config } from "@/config/settings";
import { getCaptchaProvider } from "@/captcha/factory";
import {
  approveJoinRequest,
  completeVerification,
  getJoinRequestByToken,
  getVerificationSession,
  isSessionExpired,
} from "@/database/operations";
import { autoApproveUser } from "@/services/approval";
import { getClientIp } from "@/utils/client-info";
import { validateInitData } from "@/utils/telegram";

interface VerificationRequestBody {
  token?: unknown;
  captcha_response?: unknown;
  user_id?: unknown;
  init_data?: unknown;
}

function httpError(status: number, detail: string): NextResponse {
  return NextResponse.json({ detail }, { status });
}

export async function POST(request: NextRequest) {
  let body: VerificationRequestBody;
  try {
    body = (await request.json()) as VerificationRequestBody;
  } catch {
    return httpError(422, "请求格式错误");
  }

  const token = typeof body.token === "string" ? body.token : null;
  const captchaResponse = typeof body.captcha_response === "string" ? body.captcha_response : null;

  if (!token || !captchaResponse) {
    return httpError(422, "请求格式错误");
  }

  try {
    console.log(`Processing verification for token: ${token.slice(0, 8)}...`);

    const session = await getVerificationSession(token);
    if (!session) {
      console.warn(`Verification session not found: ${token.slice(0, 8)}...`);
      return httpError(404, "验证会话不存在或已过期");
    }

    if (isSessionExpired(session)) {
      console.warn(`Verification session expired: ${token.slice(0, 8)}...`);
      return httpError(400, "验证会话已过期，请重新申请");
    }

    if (session.captchaCompleted) {
      console.warn(`Verification already completed: ${token.slice(0, 8)}...`);
      return httpError(400, "验证已完成，请勿重复提交");
    }

    const joinRequest = await getJoinRequestByToken(token);
    const isApiRequest =
      session.chatId === 0n || (joinRequest !== null && joinRequest.requestType === "api");

    const telegramUser = validateInitData(
      typeof body.init_data === "string" ? body.init_data : "",
      config.bot.token,
    );

    let identityOk: boolean;
    let claimedUserId: number | null;
    if (telegramUser) {
      claimedUserId = telegramUser.id;
      identityOk = claimedUserId === Number(session.userId);
    } else if (!isApiRequest) {
      claimedUserId = null;
      identityOk = false;
    } else {
      claimedUserId = typeof body.user_id === "number" ? body.user_id : null;
      identityOk = claimedUserId === null || claimedUserId === Number(session.userId);
    }

    if (!identityOk) {
      console.warn(
        `User identity check failed for token ${token.slice(0, 8)}...: expected ${session.userId}, got ${claimedUserId}`,
      );
      return httpError(403, "用户身份验证失败");
    }

    const clientIp = getClientIp(request);
    const userAgent = request.headers.get("user-agent");

    const captchaProvider = await getCaptchaProvider();
    const verificationResult = await captchaProvider.verify(captchaResponse, clientIp, userAgent);

    if (!verificationResult.success) {
      console.warn(`Captcha verification failed: ${verificationResult.errorCode}`);
      return httpError(400, verificationResult.errorMessage ?? "验证失败，请重试");
    }

    const success = await completeVerification({
      token,
      captchaResponse,
      ipAddress: clientIp,
      userAgent,
    });

    if (!success) {
      console.error(`Failed to complete verification: ${token.slice(0, 8)}...`);
      return httpError(500, "服务器错误，请稍后重试");
    }

    if (isApiRequest && (joinRequest === null || joinRequest.chatId === 0n)) {
      if (joinRequest !== null && !(await approveJoinRequest(token))) {
        console.warn(`Failed to mark API request as approved: ${token.slice(0, 8)}...`);
      }
      console.log(`Verification completed for API request (no chat): ${token.slice(0, 8)}...`);
      return NextResponse.json({ success: true, message: "✅ 验证成功！" });
    }

    const approvalResult = await autoApproveUser(token);
    if (!approvalResult.success) {
      console.warn(`Auto-approval failed: ${approvalResult.error}`);
      return NextResponse.json({ success: true, message: "✅ 验证成功！" });
    }

    console.log(`User auto-approved successfully: ${token.slice(0, 8)}...`);
    return NextResponse.json({
      success: true,
      message: "✅ 验证成功！",
      redirect_url: "tg://",
    });
  } catch (error) {
    console.error("Unexpected error during verification:", error);
    return httpError(500, "服务器内部错误");
  }
}
