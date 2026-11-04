import {
  approveJoinRequest,
  completeVerification,
  expireVerificationSession,
  getJoinRequestByToken,
  getPendingCodeContext,
  getVerificationMethod,
  getVerificationSession,
  getGroupSettings,
  incrementSessionAttempts,
  isSessionExpired,
  rejectJoinRequest,
  type GroupSettingsRow,
  type JoinRequestRow,
  type VerificationSessionRow,
} from "@/database/operations";
import { parseCodeApiConfig, verifyCodeExternally } from "./external-verify";
import { autoApproveUser, completeDirectJoinVerification } from "./approval";

export type CodeCheckOutcome =
  | "success"
  | "failed_retry"
  | "failed_expired"
  | "network_error"
  | "no_pending"
  | "session_stale"
  | "method_missing"
  | "bad_config";

export interface PendingContext {
  session: VerificationSessionRow;
  joinRequest: JoinRequestRow;
  settings: GroupSettingsRow | null;
}

export interface CodeCheckResult {
  outcome: CodeCheckOutcome;
  /** 机器人回复给用户的完整文案（与真实 APP 群组流程逐字一致） */
  replyText: string;
  reason?: string;
  remaining?: number;
  /** 验证成功后是否已在数据库中批准加群申请 */
  approved?: boolean;
  approvalNote?: string;
  /** true = 网络错误路径（未计入尝试次数） */
  networkError?: boolean;
  /**
   * failed_expired 时返回的群组 Chat ID（字符串化，无群组时为 null）：
   * bot 路径用它生成入群申请链接并回复「申请加群」按钮；仿真屏用它重置到申请加群入口。
   */
  reapplyChatId?: string | null;
  /** 加群申请来源（telegram=入群申请链接 / direct=直连入群 / simulator=仿真）：失效后动作不同 */
  joinRequestType?: string;
}

export interface CodeCheckInput {
  userId: bigint;
  username: string | null;
  code: string;
  /** 预加载的待验证上下文（机器人路径由 getPendingCodeContext 提供；仿真路径按 token 直查） */
  preloaded?: PendingContext | null;
  /**
   * 验证接口网络错误、服务端即将发起重试时触发一次
   * （bot 路径传入私聊发送回调，立即私聊发送「网络波动，正在重试...」；仿真路径不传）。
   */
  onNetworkRetry?: () => void | Promise<void>;
}

/**
 * 验证码校验核心管道（唯一实现，两条路径共用，保证行为完全一致）：
 * 1. 真实 Telegram 群组：bot/handlers/code-input.ts → processCodeAnswer
 * 2. 管理后台「机器人测试」仿真屏：/api/admin/bots/testing/submit-code
 *
 * 文案组合逻辑与 v1.0.7 的 processCodeAnswer 保持逐字一致。
 */
export async function evaluateSubmittedCode(input: CodeCheckInput): Promise<CodeCheckResult> {
  const code = input.code.trim();
  if (!code) {
    return { outcome: "no_pending", replyText: "请输入验证码" };
  }

  const pending = input.preloaded ?? (await getPendingCodeContext(input.userId));
  if (!pending) {
    return { outcome: "no_pending", replyText: "" };
  }

  const { session, joinRequest, settings } = pending;
  const methodId = settings?.methodId ?? null;
  if (!methodId) {
    return { outcome: "method_missing", replyText: "当前验证方式不可用，请联系管理员" };
  }

  const method = await getVerificationMethod(methodId);
  if (!method || !method.enabled) {
    return { outcome: "method_missing", replyText: "当前验证方式不可用，请联系管理员" };
  }

  const apiConfig = parseCodeApiConfig(method.config);
  if (!apiConfig) {
    console.error(`Invalid code API config for method ${method.id}`);
    return { outcome: "bad_config", replyText: "验证配置异常，请联系管理员" };
  }

  const result = await verifyCodeExternally(
    apiConfig,
    {
      userId: input.userId,
      username: input.username,
      code,
    },
    { onNetworkRetry: input.onNetworkRetry },
  );

  if (!result.ok) {
    if (result.networkError) {
      // 网络波动是基础设施故障，不是用户输入错误：绝不计入尝试次数、不失效会话。
      // 服务端已在 verifyCodeExternally 内自动重试 3 次，全部失败后才走到这里。
      return {
        outcome: "network_error",
        replyText: `${result.message}\n本次未消耗尝试次数，请稍后重新发送验证码。`,
        reason: result.message,
        networkError: true,
      };
    }
    const attempts = await incrementSessionAttempts(session.token);
    const maxAttempts = settings?.maxAttempts ?? 3;
    const remaining = Math.max(0, maxAttempts - attempts);
    if (remaining <= 0) {
      await expireVerificationSession(session.token);
      await rejectJoinRequest(session.token);
      if (joinRequest.requestType === "telegram" && joinRequest.chatId !== 0n) {
        try {
          const { dismissJoinRequest } = await import("./approval");
          await dismissJoinRequest(joinRequest.chatId, joinRequest.userId);
        } catch (error) {
          console.warn("Failed to dismiss join request after max attempts:", error);
        }
      }
      return {
        outcome: "failed_expired",
        replyText: `${settings?.failureText ?? "❌ 验证码错误，请重试。"}\n错误原因：${result.message}\n尝试次数已达上限，本次验证已失效，请重新申请加群。`,
        reason: result.message,
        remaining: 0,
        reapplyChatId: joinRequest.chatId !== 0n ? joinRequest.chatId.toString() : null,
        joinRequestType: joinRequest.requestType,
      };
    }
    return {
      outcome: "failed_retry",
      replyText: `${settings?.failureText ?? "❌ 验证码错误，请重试。"}\n错误原因：${result.message}\n剩余尝试次数：${remaining}`,
      reason: result.message,
      remaining,
    };
  }

  const completed = await completeVerification({
    token: session.token,
    captchaResponse: `code_api:${code}`,
  });
  if (!completed) {
    return { outcome: "session_stale", replyText: "验证会话已失效，请重新申请加群" };
  }

  let approved = false;
  let approvalNote: string | undefined;
  if (joinRequest.chatId === 0n) {
    console.log(`Code verification completed for API request: ${session.token}`);
  } else if (joinRequest.requestType === "simulator") {
    // 仿真路径：不调用 Telegram API（真实流程为 approveChatJoinRequest），直接落库批准
    approved = await approveJoinRequest(session.token);
    approvalNote = approved
      ? "仿真环境：已直接批准加群申请（跳过 Telegram API 调用）"
      : "仿真环境：加群申请状态更新失败";
    console.log(`Simulator join request auto-approved for token ${session.token.slice(0, 8)}...`);
  } else if (joinRequest.requestType === "direct") {
    // 直连入群路径（v1.1.3）：用户已物理在群内，无需 Telegram 审批，落库标记通过 + 私聊祝贺
    const completion = await completeDirectJoinVerification(session.token);
    approved = completion.success;
    if (!completion.success) {
      approvalNote = completion.error ?? undefined;
      console.warn(`Direct-join completion failed after code verification: ${completion.error}`);
    }
  } else {
    const approval = await autoApproveUser(session.token);
    approved = approval.success;
    if (!approval.success) {
      approvalNote = approval.error ?? undefined;
      console.warn(`Auto-approval failed after code verification: ${approval.error}`);
    }
  }

  return {
    outcome: "success",
    replyText: settings?.successText ?? "✅ 验证成功，欢迎加入！",
    approved,
    approvalNote,
  };
}

/**
 * 按 token 直查待验证上下文（机器人测试仿真屏专用）。
 * 与真实路径 getPendingCodeContext 的判定条件保持一致：
 * 会话 method=code_api、未完成、未过期，且加群申请仍为 pending。
 */
export async function loadPendingContextByToken(token: string): Promise<PendingContext | null> {
  const session = await getVerificationSession(token);
  if (!session || session.method !== "code_api" || session.captchaCompleted || isSessionExpired(session)) {
    return null;
  }
  const joinRequest = await getJoinRequestByToken(token);
  if (!joinRequest || joinRequest.status !== "pending") {
    return null;
  }
  const settings = await getGroupSettings(session.chatId);
  return { session, joinRequest, settings };
}
