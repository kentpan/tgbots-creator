import { NextResponse, type NextRequest } from "next/server";
import { config } from "@/config/settings";
import { getCaptchaProvider } from "@/captcha/factory";
import {
  approveJoinRequest,
  completeVerification,
  getGroupSettings,
  getJoinRequestByToken,
  getVerificationSession,
  isSessionExpired,
} from "@/database/operations";
import { autoApproveUser, completeGroupVerification } from "@/services/approval";
import { evaluateSubmittedCode } from "@/services/verification-flow";
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

    // v2.0.5 群内验证：URL 按钮在群内以浏览器打开（无 Telegram WebApp initData），
    // 持有 token 本身即身份凭据（链接仅出现在目标用户参与的群内，且 32 位随机不可猜测）；
    // code_api 还需在页面输入有效卡密，captcha 为纯人机验证 —— 代打风险与群验证 bot 通行做法一致。
    const groupChannel =
      session.chatId !== 0n &&
      (await getGroupSettings(session.chatId))?.verificationChannel === "group";

    const telegramUser = await validateInitData(
      typeof body.init_data === "string" ? body.init_data : "",
      config.bot.token,
    );

    let identityOk: boolean;
    let claimedUserId: number | null;
    if (telegramUser) {
      claimedUserId = telegramUser.id;
      identityOk = claimedUserId === Number(session.userId);
    } else if (groupChannel) {
      claimedUserId = null;
      identityOk = true;
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

    // v2.0.5 网页输码通道（群内验证 code_api 主通道）：会话方式为 code_api/code_self 时，
    // captcha_response 携带的是用户输入的验证码，走统一校验管道 evaluateSubmittedCode
    // （外部卡密 API / 本地比对、尝试次数、失效后群内踢出/解禁/删提示全部复用）。
    if (session.method === "code_api" || session.method === "code_self") {
      if (!joinRequest || joinRequest.status !== "pending") {
        return httpError(400, "验证已失效，请重新申请加群");
      }
      const settings = await getGroupSettings(session.chatId);
      const result = await evaluateSubmittedCode({
        userId: session.userId,
        username: null,
        code: captchaResponse,
        preloaded: { session, joinRequest, settings },
      });
      if (result.outcome === "success") {
        console.log(`Web code verification succeeded: ${token.slice(0, 8)}...`);
        return NextResponse.json({
          success: true,
          message: result.replyText || "✅ 验证成功！",
          redirect_url: "tg://",
        });
      }
      const status = result.outcome === "network_error" ? 502 : 400;
      return httpError(status, result.replyText || "验证失败，请重试");
    }

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

    // v2.0.5 群内验证完成入口：落库批准 + 解禁 + 删除群内验证提示 + 群内欢迎
    if (groupChannel) {
      const completion = await completeGroupVerification(token);
      if (!completion.success) {
        console.warn(`Group completion after web captcha failed: ${completion.error}`);
        return NextResponse.json({ success: true, message: "✅ 验证成功！" });
      }
      console.log(`User group-verified successfully: ${token.slice(0, 8)}...`);
      return NextResponse.json({
        success: true,
        message: "✅ 验证成功！",
        redirect_url: "tg://",
      });
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
