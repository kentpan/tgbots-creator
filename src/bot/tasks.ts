import { config } from "@/config/settings";
import { getRuntimeSettings } from "@/config/runtime-settings";
import { cleanupExpiredSessions, purgeStaleRecords } from "@/database/operations";
import {
  dismissJoinRequest,
  kickUnverifiedMember,
  notifyVerificationExpired,
} from "@/services/approval";

export const CLEANUP_INTERVAL_SECONDS = 60;
export const PURGE_INTERVAL_SECONDS = 24 * 60 * 60;

export async function cleanupAndDismissExpiredRequests(): Promise<void> {
  try {
    const expiredTargets = await cleanupExpiredSessions();
    for (const target of expiredTargets) {
      let groupActionOk = false;
      try {
        if (target.requestType === "direct") {
          // 直连入群防线：超时未验证的直接进群者 → 踢出群组（ban+unban，可重新申请）
          groupActionOk = await kickUnverifiedMember(target.chatId, target.userId);
        } else {
          groupActionOk = await dismissJoinRequest(target.chatId, target.userId);
        }
      } catch (error) {
        console.warn(
          `Skip expiry action for user ${target.userId} (chat ${target.chatId}, type=${target.requestType}):`,
          error,
        );
      }
      // v1.1.4：超时必须有明确通知（用户要求）——私聊告知「申请被拒/已移出群组」
      // 并附「申请加群」按钮，让用户能自行重新发起加群申请，绝不静默失效
      try {
        await notifyVerificationExpired(
          target.chatId,
          target.userId,
          target.requestType,
          groupActionOk,
        );
      } catch (error) {
        console.warn(
          `Timeout notice failed for user ${target.userId} (chat ${target.chatId}, type=${target.requestType}):`,
          error,
        );
      }
    }
  } catch (error) {
    console.error("Error in cleanup_and_dismiss_expired_requests:", error);
  }
}

export async function purgeOldRecords(): Promise<void> {
  try {
    const runtime = await getRuntimeSettings(config);
    await purgeStaleRecords(runtime.cleanupRetentionDays);
  } catch (error) {
    console.error("Error in purge_old_records:", error);
  }
}

export async function runCleanupLoop(
  intervalSeconds = CLEANUP_INTERVAL_SECONDS,
  signal?: AbortSignal,
): Promise<never | void> {
  const retentionDays = config.cleanup.retentionDays;
  console.log(`Cleanup loop started (interval=${intervalSeconds}s, retention=${retentionDays}d)`);
  let elapsedSincePurge = PURGE_INTERVAL_SECONDS;
  while (!signal?.aborted) {
    try {
      await cleanupAndDismissExpiredRequests();
      if (elapsedSincePurge >= PURGE_INTERVAL_SECONDS) {
        await purgeOldRecords();
        elapsedSincePurge = 0;
      }
    } catch (error) {
      console.error("Cleanup loop iteration failed:", error);
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalSeconds * 1000);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    elapsedSincePurge += intervalSeconds;
  }
}
