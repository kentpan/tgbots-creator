import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission } from "@/lib/auth";
import { getVerificationSession } from "@/database/operations";
import {
  evaluateSubmittedCode,
  loadPendingContextByToken,
} from "@/services/verification-flow";

/**
 * 提交验证码（机器人测试页仿真屏）。
 * 核心校验走 @/services/verification-flow 的共享管道，
 * 与真实 Telegram 群组验证（bot/handlers/code-input.ts）完全一致：
 * 同一外部验证 API、同一尝试次数控制、同一成功/失败文案。
 */
export async function POST(request: Request): Promise<NextResponse> {

  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "bots:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }

  let payload: { token?: string; code?: string };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const token = String(payload.token ?? "").trim();
  const code = String(payload.code ?? "").trim();
  if (!token || !code) {
    return NextResponse.json({ ok: false, error: "缺少验证会话或验证码" }, { status: 400 });
  }

  const session = await getVerificationSession(token);
  if (!session) {
    return NextResponse.json({
      ok: true,
      data: { outcome: "session_stale", replyText: "验证会话已失效，请重新申请加群" },
    });
  }
  if (session.captchaCompleted) {
    return NextResponse.json({
      ok: true,
      data: {
        outcome: "success",
        replyText: "本次加群验证已完成，无需重复提交。",
        session: { attempts: session.attempts, completed: true },
      },
    });
  }

  const pending = await loadPendingContextByToken(token);
  if (!pending) {
    return NextResponse.json({
      ok: true,
      data: { outcome: "session_stale", replyText: "验证会话已失效，请重新申请加群" },
    });
  }

  const result = await evaluateSubmittedCode({
    userId: pending.session.userId,
    username: pending.joinRequest.username,
    code,
    preloaded: pending,
  });

  const refreshed = await getVerificationSession(token);

  // 隐私红线（v1.1.3）：仿真动作一律只停留在仿真屏，绝不真实发送到群组、
  // 也绝不真实调用批准入群接口 —— 群组内不允许出现验证消息。

  return NextResponse.json({
    ok: true,
    data: {
      outcome: result.outcome,
      replyText: result.replyText,
      reason: result.reason ?? null,
      remaining: result.remaining ?? null,
      approved: result.approved ?? false,
      approval_note: result.approvalNote ?? null,
      /** true = 网络错误路径：未计入尝试次数，会话仍有效，可直接重新发送验证码 */
      network_error: result.networkError ?? false,
      /** true = 验证已失效：仿真屏应把输入框位置恢复为「申请加入群组」按钮 */
      reapply: result.outcome === "failed_expired",
      reapply_chat_id: result.reapplyChatId ?? null,
      session: {
        attempts: refreshed?.attempts ?? null,
        max_attempts: pending.settings?.maxAttempts ?? 3,
        completed: result.outcome === "success",
      },
    },
  });
}
