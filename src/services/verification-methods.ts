/**
 * 验证方式统一服务（加群验证 / 门禁解锁 共用）：
 *
 * 验证方式库（verification_methods 表）是全站唯一的方式定义源，默认参数只在这里改：
 *   type=code_api   → config JSON = CodeApiConfig（外部 API 核验，见 services/external-verify.ts）
 *   type=code_self  → config JSON = VerificationParams（机器人自生成验证码，本地比对）
 *   type=captcha    → config JSON = VerificationParams（WebApp 人机验证）
 *   （v2.3 移除 stars 星星解锁类型；各类型 config JSON 都可携带 VerificationParams。）
 *
 * 参数合并规则（单一实现，加群验证与门禁共用）：
 *   生效参数 = 方式默认参数（verification_methods.config） ← bot 级覆盖（bots.config 内 override）
 *   覆盖只写入 bot 配置，绝不回写验证方式库 —— 库里默认值仅验证方式页可改。
 */

import { parseCodeApiConfig, type CodeApiConfig } from "@/services/external-verify";

export type VerificationMethodType = "code_api" | "code_self" | "captcha";

/** 验证方式携带的可调参数（两种类型通用；全部可选，缺省用内置默认） */
export interface VerificationParams {
  /** 验证超时（秒）：超时未通过按失败处理；默认 300 */
  timeout_seconds?: number;
  /** 最大尝试次数：达到后按最终失败处理（踢出/拒绝）；默认 3 */
  max_attempts?: number;
  /** 提示文案默认值（发送给用户的验证提示） */
  prompt_text?: string;
  /** 成功文案默认值 */
  success_text?: string;
  /** 失败文案默认值 */
  failure_text?: string;
}

/** 内置默认参数（验证方式未配置对应键时的最终回退值） */
export const VERIFICATION_PARAM_DEFAULTS: Required<Pick<VerificationParams, "timeout_seconds" | "max_attempts">> = {
  timeout_seconds: 300,
  max_attempts: 3,
};

export const VERIFICATION_TEXT_DEFAULTS = {
  prompt_text: "🔐 请完成验证后加入",
  success_text: "✅ 验证成功，欢迎加入！",
  failure_text: "❌ 验证失败，请重试。",
} as const;

function readOptionalInt(value: unknown, min: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= min
    ? Math.floor(value)
    : undefined;
}

function readOptionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 从方式 config JSON 中提取通用参数键（忽略未知字段，绝不抛错） */
export function parseVerificationParams(raw: string | null | undefined): VerificationParams {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const cfg = parsed as Record<string, unknown>;
  return {
    timeout_seconds: readOptionalInt(cfg.timeout_seconds, 1),
    max_attempts: readOptionalInt(cfg.max_attempts, 1),
    prompt_text: readOptionalText(cfg.prompt_text),
    success_text: readOptionalText(cfg.success_text),
    failure_text: readOptionalText(cfg.failure_text),
  };
}

/** bot 级覆盖参数（bots.config 内 override JSON），结构同 VerificationParams */
export function parseVerificationOverride(raw: unknown): VerificationParams {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const cfg = raw as Record<string, unknown>;
  return {
    timeout_seconds: readOptionalInt(cfg.timeout_seconds, 1),
    max_attempts: readOptionalInt(cfg.max_attempts, 1),
    prompt_text: readOptionalText(cfg.prompt_text),
    success_text: readOptionalText(cfg.success_text),
    failure_text: readOptionalText(cfg.failure_text),
  };
}

/**
 * 参数合并（低 → 高：内置默认 → 方式默认 → bot 覆盖）。
 * 返回全部键有值（Required），调用方直接使用，不再各自兜底。
 */
export function mergeVerificationParams(
  methodParams: VerificationParams,
  override?: VerificationParams,
): Required<VerificationParams> {
  const pick = (key: keyof VerificationParams): string | number => {
    const fromOverride = override?.[key];
    if (fromOverride !== undefined) return fromOverride;
    const fromMethod = methodParams[key];
    if (fromMethod !== undefined) return fromMethod;
    return key === "timeout_seconds"
      ? VERIFICATION_PARAM_DEFAULTS.timeout_seconds
      : key === "max_attempts"
        ? VERIFICATION_PARAM_DEFAULTS.max_attempts
        : VERIFICATION_TEXT_DEFAULTS[key as keyof typeof VERIFICATION_TEXT_DEFAULTS];
  };
  return {
    timeout_seconds: pick("timeout_seconds") as number,
    max_attempts: pick("max_attempts") as number,
    prompt_text: pick("prompt_text") as string,
    success_text: pick("success_text") as string,
    failure_text: pick("failure_text") as string,
  };
}

/** 解析方式行的完整配置：按 type 分派（code_api / code_self / captcha） */
export function parseMethodConfigByType(
  type: string,
  raw: string,
): { kind: "code_api"; config: CodeApiConfig } | { kind: "code_self" | "captcha"; config: VerificationParams } | null {
  if (type === "code_self" || type === "captcha") {
    return { kind: type, config: parseVerificationParams(raw) };
  }
  const codeApi = parseCodeApiConfig(raw);
  return codeApi ? { kind: "code_api", config: codeApi } : null;
}

/** 方式类型展示名（列表/选择器统一文案） */
export function verificationMethodTypeLabel(type: string): string {
  if (type === "code_self") return "自动验证码";
  if (type === "captcha") return "人机验证（WebApp）";
  return "验证码核验 API";
}
