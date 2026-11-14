/**
 * 加群验证解析服务（机器人能力 + 群组策略的统一解析口）：
 *
 * 数据来源：
 *   bots.config.joinVerify = { enabled, override? }（机器人级能力开关 + 全局参数覆盖）
 *   group_settings.join_verify_mode / join_verify_method_id = 群组私有策略
 *   验证方式行 = verification_methods（type: code_api / code_self / captcha）
 *   生效参数 = 方式默认参数 ← bot 级 override（mergeVerificationParams）
 *
 * 渠道语义（源头规则，无配置项）：
 *   - 申请制入群（chat_join_request，被指定的加群验证机器人）：按群组 mode 选择验证或直接审批；
 *   - 直连入群（chat_member 补验证）：超级群 → 群内验证，基础群 → 私聊验证（auto 语义）；
 *   - 频道：物理不支持群内验证（订阅者不能发言），强制私聊验证。
 *
 * 运行时文本（提示/成功/失败）= group_settings 三列（群信息弹窗维护，
 * 表单预填文案保存在群组列；超时/次数由机器人级 override 覆盖验证方式默认值。
 */

import { getBot, getGroupSettings, getVerificationMethod, type GroupSettingsRow } from "@/database/operations";
import { parseBotFeatureConfig } from "@/services/bot-feature-config";
import {
  mergeVerificationParams,
  parseVerificationParams,
} from "@/services/verification-methods";
import { parseCodeApiConfig } from "@/services/external-verify";

export type JoinVerifyMethod = "code_api" | "code_self" | "captcha" | "direct";

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
  if (!feature.joinVerify.enabled) return null;
  if (settings?.joinVerifyMode === "direct" || ((!settings || settings.joinVerifyMode === null) && feature.joinVerify.mode === "direct")) {
    return { method: "direct", methodDbId: null, timeoutSeconds: 0, maxAttempts: 0 };
  }
  // v2.3.5 群组绑定方式优先；仅对尚未显式设置群组策略的历史群组回退旧机器人级 methodId。
  const methodId = settings?.joinVerifyMethodId ?? ((!settings || settings.joinVerifyMode === null) && feature.joinVerify.methodId ? BigInt(feature.joinVerify.methodId) : null);
  if (!methodId) return null;
  const method = await getVerificationMethod(methodId);
  if (!method || !method.enabled) {
    console.error(
      `[join-verify] bot #${botId} joinVerify method ${methodId} missing or disabled`,
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

/** 加群验证机器人候选：机器人级只控制自动响应能力开关，审核策略由群组设置决定。 */
export async function listJoinVerifyCapableBotIds(): Promise<Set<string>> {
  const { listBots } = await import("@/database/operations");
  const bots = await listBots();
  const result = new Set<string>();
  for (const bot of bots) {
    const feature = parseBotFeatureConfig(bot.config, false);
    if (bot.enabled && feature.joinVerify.enabled) {
      result.add(String(bot.id));
    }
  }
  return result;
}

/** 群组设置读取捷径（join-verify composer 与 chat-member 共用，避免各自直连 operations） */
export async function loadGroupSettingsForChat(chatId: bigint): Promise<GroupSettingsRow | null> {
  return getGroupSettings(chatId);
}
