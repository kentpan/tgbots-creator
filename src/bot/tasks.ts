import { config } from "@/config/settings";
import { getRuntimeSettings } from "@/config/runtime-settings";
import { getDatabase } from "@/database/client";
import {
  cleanupExpiredSessions,
  getGroupSettings,
  purgeStaleRecords,
} from "@/database/operations";
import {
  deleteSessionPromptMessage,
  dismissJoinRequest,
  kickUnverifiedMember,
  notifyVerificationExpired,
  sendGroupTimeoutNotice,
} from "@/services/approval";
import { isBackupDue, loadBackupSettings, markBackupRan, parseBackupConfig, runBackup } from "@/lib/backup/backup-runner";
import { getBackupStore } from "@/lib/backup/backup-store";
import { keepLatestApiLogs, API_LOGS_MAX_ROWS } from "@/lib/api-log";

export const CLEANUP_INTERVAL_SECONDS = 60;
export const PURGE_INTERVAL_SECONDS = 24 * 60 * 60;

export async function cleanupAndDismissExpiredRequests(): Promise<void> {
  try {
    const expiredTargets = await cleanupExpiredSessions();
    for (const target of expiredTargets) {
      // v2.0.5 群内验证模式：入群申请链接用户 bootstrap 阶段已在 Telegram 侧批准
      // （join_requests.status 保持 pending 直到验证通过），用户已物理在群内 ——
      // 超时未验证统一按「删群内提示 + 群内告知 + 踢出」处理，不再区分申请类型。
      // v2.0.7 直连入群踢出开关（默认关闭）：通过公开邀请链接/被拉入群的「已有用户」
      // （requestType=direct）验证超时不自动踢出，仅失效会话/申请 + 清理群内提示，
      // 禁言随 until_date 到期自动解除、成员保留在群内；开关开启时维持旧行为。
      const settings = await getGroupSettings(target.chatId);
      const groupChannel =
        target.chatId !== 0n && settings?.verificationChannel === "group";
      const kickDirectAllowed = settings?.kickDirectJoins ?? false;
      const kickAllowed = target.requestType !== "direct" || kickDirectAllowed;
      let groupActionOk = false;
      try {
        if (groupChannel) {
          await deleteSessionPromptMessage(target.token);
          if (kickAllowed) {
            await sendGroupTimeoutNotice(target.chatId, target.userId);
            groupActionOk = await kickUnverifiedMember(target.chatId, target.userId);
          } else {
            await sendGroupTimeoutNotice(target.chatId, target.userId, { kicked: false });
            groupActionOk = false;
          }
        } else if (target.requestType === "direct") {
          // 直连入群防线：超时未验证的直接进群者 → 踢出群组（ban+unban，可重新申请）；
          // v2.0.7：开关关闭时保留在群内（仅失效会话，不发移出通知）
          if (kickAllowed) {
            groupActionOk = await kickUnverifiedMember(target.chatId, target.userId);
          } else {
            console.log(
              `Direct-join user ${target.userId} (chat ${target.chatId}) verification ` +
                "expired — kick_direct_joins disabled, member stays in group",
            );
            groupActionOk = false;
          }
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
      // 并附「申请加群」按钮，让用户能自行重新发起加群申请，绝不静默失效；
      // v2.0.5：群内模式已额外发送群内提示（私聊不可达时群内消息也能被看到）；
      // v2.0.7：直连用户未被踢出（开关默认关闭）时私聊告知「仍保留在群组中」
      try {
        await notifyVerificationExpired(
          target.chatId,
          target.userId,
          target.requestType,
          groupActionOk,
          groupChannel,
          { kicked: kickAllowed },
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

/**
 * v2.2.5：api_logs 容量封顶（保留最近 API_LOGS_MAX_ROWS 行，随清理循环周期执行）；
 * 失败仅记日志，绝不影响清理主循环。
 */
async function capApiLogs(): Promise<void> {
  try {
    const removed = await keepLatestApiLogs();
    if (removed > 0) {
      console.log(`[api-log] 容量封顶清理：删除 ${removed} 条旧日志（保留最近 ${API_LOGS_MAX_ROWS} 条）`);
    }
  } catch (error) {
    console.error("[api-log] 容量封顶清理失败:", error);
  }
}

export async function purgeOldRecords(): Promise<void> {
  try {
    const runtime = await getRuntimeSettings(config);
    await purgeStaleRecords(runtime.cleanupRetentionDays);
  } catch (error) {
    console.error("Error in purge_old_records:", error);
  }
  await capApiLogs();
}

/**
 * 定时备份到点检查（v2.2.3 备份管理，xianyu-admin 复刻）：
 * Cloudflare 部署用 cron 回调端点（/api/admin/backup/cron，令牌鉴权）；
 * 本地 Node 常驻部署由清理循环每轮（60s）顺带判定 isBackupDue ——
 * 每 X 天 X时X分X秒 到点才真正执行，绝不重复备份；存储未就绪/库不可用
 * 如实记日志，不影响清理主循环。
 */
async function runBackupScheduleTick(): Promise<void> {
  try {
    const db = await getDatabase();
    const cfg = parseBackupConfig(await loadBackupSettings(db));
    const due = isBackupDue(cfg);
    if (!due.due) return;
    const store = await getBackupStore();
    const result = await runBackup(db, store, cfg.tables);
    await markBackupRan(db);
    console.log(
      `[backup-schedule] 定时备份完成: ${result.key} (${result.tables.length} 表 / ${result.rows} 行 → ${result.storage})`,
    );
  } catch (error) {
    console.error("Backup schedule tick failed:", error);
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
      await runBackupScheduleTick();
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
