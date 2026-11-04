import { NextResponse } from "next/server";
import {
  getJoinRequestByToken,
  getVerificationSession,
  isSessionExpired,
} from "@/database/operations";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  try {
    const session = await getVerificationSession(token);

    if (!session) {
      return NextResponse.json({ detail: "验证会话不存在" }, { status: 404 });
    }

    const joinRequest = await getJoinRequestByToken(token);

    return NextResponse.json({
      token,
      completed: session.captchaCompleted,
      expired: isSessionExpired(session),
      status: joinRequest ? joinRequest.status : "unknown",
      created_time: session.createdTime.toISOString(),
      expires_at: session.expiresAt.toISOString(),
    });
  } catch (error) {
    console.error("Error getting verification status:", error);
    return NextResponse.json({ detail: "服务器内部错误" }, { status: 500 });
  }
}
