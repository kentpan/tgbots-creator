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

import { getBot, getGroupSettings, getVerificationMethod, resolveVerificationChannel, type GroupSettingsRow } from "@/database/operations";
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
  /**
   * v3.0.3 修复（2026-11-15 计数事故）：code_api 的 config.timeout_seconds 是
   * 「外部 API 单次请求超时」（5-60 秒），曾被误当作验证会话有效期写入 expires_at
   * —— 用户输到第 3 次时会话早已过期，表现为「第 3 次不管对错都提示会话超时失效」。
   * 会话有效期一律使用 sessionTimeoutSeconds；timeoutSeconds 仅保留兼容展示。
   */
  timeoutSeconds: number;
  /** 验证会话有效期（秒）：expires_at = 创建时刻 + sessionTimeoutSeconds（下限 60） */
  sessionTimeoutSeconds: number;
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
    return { method: "direct", methodDbId: null, timeoutSeconds: 0, sessionTimeoutSeconds: 0, maxAttempts: 0 };
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

  // v3.0.3：会话有效期下限 60 秒 —— 保护用户至少有一次完整的输码机会；
  // code_api 的 config.timeout_seconds（外部 API 请求超时，5-60 秒）绝不当会话时长。
  const sessionTimeoutSeconds = Math.min(Math.max(params.session_timeout_seconds ?? 300, 60), 86400);

  switch (method.type) {
    case "code_api": {
      const apiConfig = parseCodeApiConfig(method.config);
      if (!apiConfig) {
        console.error(`[join-verify] bot #${botId} method ${method.id} has invalid code API config`);
        return null;
      }
      // timeoutSeconds = 外部 API 请求超时（仅兼容展示）；会话有效期用 sessionTimeoutSeconds
      return { method: "code_api", methodDbId: method.id, timeoutSeconds: params.timeout_seconds, sessionTimeoutSeconds, maxAttempts: params.max_attempts };
    }
    case "code_self":
      return { method: "code_self", methodDbId: method.id, timeoutSeconds: params.timeout_seconds, sessionTimeoutSeconds, maxAttempts: params.max_attempts };
    case "captcha":
      return { method: "captcha", methodDbId: method.id, timeoutSeconds: params.timeout_seconds, sessionTimeoutSeconds, maxAttempts: params.max_attempts };
    default:
      console.error(`[join-verify] bot #${botId} method ${method.id} has unsupported type ${method.type}`);
      return null;
  }
}

/**
 * v3.0.3 加群验证渠道统一判定（运行时 bootstrap 与验证网页 /api/v1/verify 共用同一实现）。
 *
 * 源头规则（配置与验证逻辑必须相匹配）:
 * - join_verify_mode 显式值优先："group" = 群内验证 / "dm" = 私聊验证
 *   （仿真屏「申请处理方式」拆分后的两个验证选项，配置直接决定渠道）；
 * - 历史值 "verify" / null（未拆分前的「验证码验证后通过」/ 未保存）：
 *   申请制（chat_join_request）→ 私聊验证（先验证后批准）；
 *   直连入群 → verification_channel 列三态语义（auto：超级群→群内 / 基础群→私聊）。
 *
 * Telegram 物理约束（基础群无禁言/申请审批、频道订阅者不能发言 → 不能群内验证）
 * 由调用方在 bootstrap 处用 chatCapabilities 强制回落 dm，本函数不做群型判断。
 */
export function resolveJoinVerifyChannel(
  settings: GroupSettingsRow | null,
  chatId: bigint | number | string | null | undefined,
  requestType: "telegram" | "direct",
): "group" | "dm" {
  const mode = settings?.joinVerifyMode ?? null;
  if (mode === "group") return "group";
  if (mode === "dm") return "dm";
  if (requestType === "telegram") return "dm";
  return resolveVerificationChannel(settings, chatId);
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
