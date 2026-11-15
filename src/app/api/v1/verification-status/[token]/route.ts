import { NextResponse } from "next/server";
import { getJoinRequestByToken, getVerificationSession, isSessionExpired } from "@/database/operations";
import { settleCompletedVerification } from "@/services/approval";

/**
 * v3.0.4 轮询自愈节流：同一 token 的补偿结算至多每 10 秒尝试一次，
 * 防止验证页 3 秒轮询期间反复调用 Telegram API。
 */
const HEAL_MIN_INTERVAL_MS = 10_000;
const globalForHeal = globalThis as unknown as { __verifyHealAt?: Map<string, number> };
const healAt = globalForHeal.__verifyHealAt ?? new Map<string, number>();
globalForHeal.__verifyHealAt = healAt;

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

    let joinRequest = await getJoinRequestByToken(token);

    // v3.0.4 自愈结算：人机验证已完成但加群申请仍是 pending（首次结算曾因
    // Telegram 瞬时故障/机器人解析失败中断，用户端表现为验证页「一直卡在等待处理」、
    // 群内提示未删、禁言未解）——由验证页的轮询在此补偿推进，直到成功或用户离开页面。
    // settleCompletedVerification 与 POST /api/v1/verify 的完成分支同源且幂等。
    if (session.captchaCompleted && joinRequest?.status === "pending") {
      const now = Date.now();
      const last = healAt.get(token) ?? 0;
      if (now - last >= HEAL_MIN_INTERVAL_MS) {
        if (healAt.size > 500) healAt.clear();
        healAt.set(token, now);
        const settled = await settleCompletedVerification(token);
        if (settled.ok) {
          console.log(`Verification self-heal settled: ${token.slice(0, 8)}... — approved`);
          joinRequest = await getJoinRequestByToken(token);
        } else {
          console.warn(
            `Verification self-heal attempt failed: ${token.slice(0, 8)}... — ${settled.error}`,
          );
        }
      }
    }

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
