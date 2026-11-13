/**
 * 加群验证解析服务（机器人级验证方式配置的唯一解析口）：
 *
 * 数据来源（验证方式配置已从群级迁到机器人级）：
 *   bots.config.joinVerify = { enabled, methodId, override? }
 *   验证方式行 = verification_methods（type: code_api / code_self / captcha）
 *   生效参数 = 方式默认参数 ← bot 级 override（mergeVerificationParams）
 *
 * 渠道语义（源头规则，无配置项）：
 *   - 申请制入群（chat_join_request，被指定的加群验证机器人）：一律私聊验证
 *     （先验证后批准 —— 通过 approveChatJoinRequest 静默放行，失败 3 次 declineChatJoinRequest）；
 *   - 直连入群（chat_member 补验证）：超级群 → 群内验证，基础群 → 私聊验证（auto 语义）；
 *   - 频道：物理不支持群内验证（订阅者不能发言），强制私聊验证。
 *
 * 运行时文本（提示/成功/失败）= group_settings 三列（群信息弹窗维护，
 * 表单预填生效值：群组覆盖 > 机器人默认 > 方式默认），运行时只读群列，单一来源。
 */

import { getBot, getGroupSettings, getVerificationMethod, type GroupSettingsRow } from "@/database/operations";
import { parseBotFeatureConfig } from "@/services/bot-feature-config";
import {
  mergeVerificationParams,
  parseVerificationParams,
} from "@/services/verification-methods";
import { parseCodeApiConfig } from "@/services/external-verify";

export type JoinVerifyMethod = "code_api" | "code_self" | "captcha";

export interface ResolvedJoinVerify {
  method: JoinVerifyMethod;
  /** 方式库行 id（会话锁定到会话记录） */
  methodDbId: bigint | null;
  timeoutSeconds: number;
  maxAttempts: number;
}

/**
 * 解析某机器人在某群组的加群验证配置。
 * 返回 null = 配置不完整/方式不可用（调用方显式记录日志，绝不静默放行）。
 */
export async function resolveJoinVerify(
  botId: bigint,
  settings: GroupSettingsRow | null,
): Promise<ResolvedJoinVerify | null> {
  const bot = await getBot(botId);
  if (!bot) {
    console.error(`[join-verify] bot #${botId} not found`);
    return null;
  }
  const feature = parseBotFeatureConfig(bot.config, false);
  if (!feature.joinVerify.enabled || !feature.joinVerify.methodId) {
    return null;
  }
  const method = await getVerificationMethod(BigInt(feature.joinVerify.methodId));
  if (!method || !method.enabled) {
    console.error(
      `[join-verify] bot #${botId} joinVerify method ${feature.joinVerify.methodId} missing or disabled`,
    );
    return null;
  }

  const params = mergeVerificationParams(
    parseVerificationParams(method.config),
    feature.joinVerify.override,
  );

  switch (method.type) {
    case "code_api": {
      const apiConfig = parseCodeApiConfig(method.config);
      if (!apiConfig) {
        console.error(`[join-verify] bot #${botId} method ${method.id} has invalid code API config`);
        return null;
      }
      return { method: "code_api", methodDbId: method.id, timeoutSeconds: params.timeout_seconds, maxAttempts: params.max_attempts };
    }
    case "code_self":
      return { method: "code_self", methodDbId: method.id, timeoutSeconds: params.timeout_seconds, maxAttempts: params.max_attempts };
    case "captcha":
      return { method: "captcha", methodDbId: method.id, timeoutSeconds: params.timeout_seconds, maxAttempts: params.max_attempts };
    default:
      console.error(`[join-verify] bot #${botId} method ${method.id} has unsupported type ${method.type}`);
      return null;
  }
}

/**
 * 指定机器人判定（多机器人竞态守卫的唯一实现）：
 * - 群未指定（join_verify_bot_id = NULL）→ 手动审核，返回 "manual"；
 * - 指定了其他机器人 → 当前机器人忽略，返回 "other"；
 * - 指定了当前机器人 → 返回 "designated"。
 */
export function resolveDesignatedBot(
  settings: GroupSettingsRow | null,
  botId: bigint,
): "manual" | "other" | "designated" {
  const designated = settings?.joinVerifyBotId ?? null;
  if (designated === null) return "manual";
  return designated === botId ? "designated" : "other";
}

/** 加群验证机器人候选（群信息弹窗「自动审核机器人」下拉数据源）：bots.config.joinVerify.enabled 的机器人 id 集合 */
export async function listJoinVerifyCapableBotIds(): Promise<Set<string>> {
  const { listBots } = await import("@/database/operations");
  const bots = await listBots();
  const result = new Set<string>();
  for (const bot of bots) {
    const feature = parseBotFeatureConfig(bot.config, false);
    if (feature.joinVerify.enabled && feature.joinVerify.methodId) {
      result.add(String(bot.id));
    }
  }
  return result;
}

/** 群组设置读取捷径（join-verify composer 与 chat-member 共用，避免各自直连 operations） */
export async function loadGroupSettingsForChat(chatId: bigint): Promise<GroupSettingsRow | null> {
  return getGroupSettings(chatId);
}
