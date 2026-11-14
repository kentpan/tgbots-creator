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
import type { Api } from "grammy";
import {
  autoApproveUser,
  completeDirectJoinVerification,
  completeGroupVerification,
  deleteSessionPromptMessage,
  kickUnverifiedMember,
  unmuteGroupMember,
} from "./approval";

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
  /**
   * v2.0.7：failed_expired 且成员未被移出群组（直连用户 kick_direct_joins 关闭，
   * 保留在群内）——调用方据此把「已被移出群组」类提示改为「仍保留在群组中」。
   */
  stayedInGroup?: boolean;
}

export interface CodeCheckInput {
  userId: bigint;
  username: string | null;
  code: string;
  /** 预加载的待验证上下文（机器人路径由 getPendingCodeContext 提供；仿真路径按 token 直查） */
  preloaded?: PendingContext | null;
  /**
   * v2.1.1 事件接收 bot：收到本次验证事件（输码/点选）的机器人 API 实例。
   * 验证通过后的审批/解禁/欢迎全部优先由它执行 —— 该 bot 必然在群内且为管理员，
   * 不依赖群组绑定行与主 bot token（edge 部署主 bot 未配置时旧实现直接断裂）。
   */
  eventApi?: Api;
  /** 用户实际输码所在的私聊 chat.id（chat_join_request 场景可能是 user_chat_id）；用于发送成功欢迎语与群组跳转按钮 */
  notificationChatId?: number;
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

  // v1.1.7：校验方按会话方式二选一 ——
  // · code_self（输入验证码加群）：机器人自生成的验证码随会话落库，本地恒定时间比对；
  // · code_api（外部卡密 API）：转发外部接口校验（原有逻辑，逐字不变）。
  // 两种方式的后续失败/成功路径完全共用，保证行为与文案一致。
  // v2.0.1：method_id 允许在任意验证方式下作为「偏好」落库保留（弹窗回显），
  // 但仅 code_api 会话消费它 —— captcha 等其他方式行为与未绑定时不一致的历史行为保持不变。
  let verdict: { ok: boolean; reason: string; networkError?: boolean; submittedLabel: string };
  if (session.method === "code_self") {
    const expected = session.expectedCode?.trim() ?? "";
    // 归一化：去空白 + 大小写不敏感（验证码为纯数字，宽松处理无安全代价，
    // 消除手机输入法空格/全角干扰）
    const normalizedInput = code.replace(/\s+/g, "");
    const ok = expected.length > 0 && normalizedInput.toLowerCase() === expected.toLowerCase();
    verdict = {
      ok,
      reason: ok ? "" : "验证码不正确",
      submittedLabel: `code_self:${code}`,
    };
  } else if (session.method === "code_api") {
    // 会话锁定的验证方式（method_id 随会话落库）：会话是不可篡改的验证凭据，
    // 校验按会话记录的方式执行，管理端事后改配置不影响进行中的会话
    const methodId = session.methodId ?? null;
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
    verdict = {
      ok: result.ok,
      reason: result.ok ? "" : result.message,
      networkError: result.ok ? undefined : result.networkError,
      submittedLabel: `code_api:${code}`,
    };
  } else {
    // captcha（WebApp 人机验证）等会话不走验证码校验管道。
    // v2.0.1 前该分支仅在 method_id 为空时触达（文案如下）；
    // method_id 偏好落库后显式隔离，保证 captcha 会话行为逐字不变。
    return { outcome: "method_missing", replyText: "当前验证方式不可用，请联系管理员" };
  }

  if (!verdict.ok) {
    if (verdict.networkError) {
      // 网络波动是基础设施故障，不是用户输入错误：绝不计入尝试次数、不失效会话。
      // 服务端已在 verifyCodeExternally 内自动重试 3 次，全部失败后才走到这里。
      return {
        outcome: "network_error",
        replyText: `${verdict.reason}\n本次未消耗尝试次数，请稍后重新发送验证码。`,
        reason: verdict.reason,
        networkError: true,
      };
    }
    const attempts = await incrementSessionAttempts(session.token);
    // 最大尝试次数：会话创建时锁定的 bot 级覆盖解析值（旧会话 NULL 回退 3）
    const maxAttempts = session.maxAttempts ?? settings?.maxAttempts ?? 3;
    const remaining = Math.max(0, maxAttempts - attempts);
    if (remaining <= 0) {
      await expireVerificationSession(session.token);
      await rejectJoinRequest(session.token);
      // v2.0.5 群内验证：用户已物理在群内（入群申请已批准/直连入群），
      // 尝试次数用尽 → 删除群内验证提示 + 踢出（ban+unban，可重新申请）。
      // 仅真实 Telegram 入群路径（telegram/direct）执行群内动作；
      // simulator/api 仿真会话绝不触碰真实群组（否则会把仿真用户踢出真实群）。
      // 私聊模式保持旧行为：telegram → 拒绝加群申请；direct → 由私聊通知路径踢出。
      // v2.0.7 直连入群踢出开关（默认关闭）：直连用户（公开邀请链接/被拉入群的
      // 已有用户）尝试次数用尽时不踢出，保留在群内 —— 仅删提示 + best effort 解禁
      // （禁言 until_date 会随会话到期自动解除，此处主动解禁保证立即恢复发言）。
      const realTelegramJoin =
        joinRequest.requestType === "telegram" || joinRequest.requestType === "direct";
      const kickDirectAllowed = settings?.kickDirectJoins ?? false;
      const kickAllowed =
        joinRequest.requestType !== "direct" || kickDirectAllowed;
      // 群内验证分支仅直连入群用户适用（用户已物理在群内）；申请制用户尚未进群，
      // 走下方 decline 分支（拒绝申请）—— 群内禁言/删提示/踢出对申请者毫无意义
      const inGroupChannel =
        joinRequest.requestType === "direct" && settings?.verificationChannel === "group";
      const stayedInGroup =
        joinRequest.chatId !== 0n &&
        realTelegramJoin &&
        inGroupChannel &&
        !kickAllowed;
      if (
        joinRequest.chatId !== 0n &&
        realTelegramJoin &&
        inGroupChannel
      ) {
        await deleteSessionPromptMessage(session.token, input.eventApi);
        if (kickAllowed) {
          try {
            await kickUnverifiedMember(joinRequest.chatId, joinRequest.userId, input.eventApi);
          } catch (error) {
            console.error(
              `Failed to kick unverified group user ${joinRequest.userId} (chat ${joinRequest.chatId}):`,
              error,
            );
          }
        } else {
          // 保留在群内：主动解禁（best effort），并记录决策日志
          try {
            await unmuteGroupMember(joinRequest.chatId, joinRequest.userId, input.eventApi);
          } catch (error) {
            console.warn(
              `Failed to unmute stayed direct-join user ${joinRequest.userId} (chat ${joinRequest.chatId}):`,
              error,
            );
          }
          console.log(
            `Direct-join user ${joinRequest.userId} (chat ${joinRequest.chatId}) failed all ` +
              "attempts — kick_direct_joins disabled, member stays in group (unmuted)",
          );
        }
      } else if (joinRequest.requestType === "telegram" && joinRequest.chatId !== 0n) {
        try {
          const { dismissJoinRequest } = await import("./approval");
          await dismissJoinRequest(joinRequest.chatId, joinRequest.userId, input.eventApi);
        } catch (error) {
          console.warn("Failed to dismiss join request after max attempts:", error);
        }
      }
      return {
        outcome: "failed_expired",
        replyText: stayedInGroup
          ? `${settings?.failureText ?? "❌ 验证码错误，请重试。"}\n错误原因：${verdict.reason}\n尝试次数已达上限，本次验证已失效，你仍保留在群组中。`
          : `${settings?.failureText ?? "❌ 验证码错误，请重试。"}\n错误原因：${verdict.reason}\n尝试次数已达上限，本次验证已失效，请重新申请加群。`,
        reason: verdict.reason,
        remaining: 0,
        reapplyChatId: joinRequest.chatId !== 0n ? joinRequest.chatId.toString() : null,
        joinRequestType: joinRequest.requestType,
        // v2.0.7：直连用户未被踢出（保留在群内）——调用方据此调整提示文案
        stayedInGroup,
      };
    }
    return {
      outcome: "failed_retry",
      replyText: `${settings?.failureText ?? "❌ 验证码错误，请重试。"}\n错误原因：${verdict.reason}\n剩余尝试次数：${remaining}`,
      reason: verdict.reason,
      remaining,
    };
  }

  const completed = await completeVerification({
    token: session.token,
    captchaResponse: verdict.submittedLabel,
  });
  if (!completed) {
    return { outcome: "session_stale", replyText: "验证会话已失效，请重新申请加群" };
  }

  let approved = false;
  let approvalNote: string | undefined;
  // 群内验证分支仅直连入群用户适用（申请批准前用户不在群内，无法群内解禁/欢迎）；
  // 申请制用户（telegram）走 autoApproveUser：approveChatJoinRequest 静默放行
  const groupChannel =
    joinRequest.chatId !== 0n &&
    joinRequest.requestType === "direct" &&
    settings?.verificationChannel === "group";
  if (joinRequest.chatId === 0n) {
    console.log(`Code verification completed for API request: ${session.token}`);
  } else if (joinRequest.requestType === "simulator") {
    // 仿真路径：不调用 Telegram API（真实流程为 approveChatJoinRequest），直接落库批准
    approved = await approveJoinRequest(session.token);
    approvalNote = approved
      ? "仿真环境：已直接批准加群申请（跳过 Telegram API 调用）"
      : "仿真环境：加群申请状态更新失败";
    console.log(`Simulator join request auto-approved for token ${session.token.slice(0, 8)}...`);
  } else if (groupChannel) {
    const completion = await completeGroupVerification(session.token, input.eventApi);
    approved = completion.success;
    if (!completion.success) {
      approvalNote = completion.error ?? undefined;
      console.warn(`Group verification completion failed: ${completion.error}`);
    }
  } else if (joinRequest.requestType === "direct") {
    // 直连入群路径（v1.1.3，私聊模式）：用户已物理在群内，无需 Telegram 审批，落库标记通过 + 私聊祝贺
    const completion = await completeDirectJoinVerification(session.token, input.eventApi);
    approved = completion.success;
    if (!completion.success) {
      approvalNote = completion.error ?? undefined;
      console.warn(`Direct-join completion failed after code verification: ${completion.error}`);
    }
  } else {
    const approval = await autoApproveUser(
      session.token,
      input.eventApi,
      input.notificationChatId,
    );
    approved = approval.success;
    if (!approval.success) {
      approvalNote = approval.error ?? undefined;
      console.warn(`Auto-approval failed after code verification: ${approval.error}`);
    }
  }

  return {
    outcome: "success",
    replyText: approved
      ? settings?.successText ?? "✅ 验证成功，欢迎加入！"
      : `验证码正确，但自动批准入群失败：${approvalNote ?? "Telegram 审批未完成"}。请联系群管理员处理。`,
    approved,
    approvalNote,
  };
}

/**
 * 按 token 直查待验证上下文（机器人测试仿真屏专用）。
 * 与真实路径 getPendingCodeContext 的判定条件保持一致：
 * 会话 method=code_api/code_self、未完成、未过期，且加群申请仍为 pending。
 */
export async function loadPendingContextByToken(token: string): Promise<PendingContext | null> {
  const session = await getVerificationSession(token);
  if (
    !session ||
    (session.method !== "code_api" && session.method !== "code_self") ||
    session.captchaCompleted ||
    isSessionExpired(session)
  ) {
    return null;
  }
  const joinRequest = await getJoinRequestByToken(token);
  if (!joinRequest || joinRequest.status !== "pending") {
    return null;
  }
  const settings = await getGroupSettings(session.chatId);
  return { session, joinRequest, settings };
}
