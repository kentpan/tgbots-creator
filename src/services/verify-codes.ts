import { getCachedAppSettings } from "@/database/operations";

const KEYS_SETTING = "verify_codes.api_keys";
export const DEFAULT_VERIFY_API_KEY = "sk-tguard-v108";

/**
 * 发码/验码开放接口（/api/verify-codes/*）的 Bearer apikey 鉴权。
 * 允许多个 Key：存储于 app_settings.verify_codes.api_keys（JSON 数组）。
 * 未配置时回落到内置演示 Key，保证开箱即可全流程联调。
 *
 * v2.1.3 D1 读行额度优化：getAppSetting（每次直读 1 行）→ getCachedAppSettings
 * （120s 全量缓存 + 进程内 memo，写路径 setAppSetting 已 invalidateCache）——
 * 外部验码是最高频的开放接口，鉴权读不再逐次打库；Key 变更最大延迟 = 其他
 * isolate 120s 追平（与全局运行时设置同一生效语义）。
 */
export async function listVerifyApiKeys(): Promise<string[]> {
  try {
    const settings = await getCachedAppSettings();
    const raw = (settings[KEYS_SETTING] ?? "").trim();
    if (!raw) return [DEFAULT_VERIFY_API_KEY];
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      const keys = parsed.map((item) => String(item).trim()).filter(Boolean);
      return keys.length > 0 ? keys : [DEFAULT_VERIFY_API_KEY];
    }
    const single = String(parsed).trim();
    return single ? [single] : [DEFAULT_VERIFY_API_KEY];
  } catch {
    return [DEFAULT_VERIFY_API_KEY];
  }
}

export interface VerifyApiAuthResult {
  ok: boolean;
  error?: string;
}

export function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export async function checkVerifyApiKey(request: Request): Promise<VerifyApiAuthResult> {
  const token = readBearerToken(request);
  if (!token) {
    return { ok: false, error: "缺少 Authorization: Bearer <apikey> 请求头" };
  }
  const keys = await listVerifyApiKeys();
  if (keys.length === 0) {
    return { ok: false, error: "服务端未配置可用 API Key" };
  }
  if (!keys.includes(token)) {
    return { ok: false, error: "API Key 无效" };
  }
  return { ok: true };
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** 生成 8 位测试加群验证码（去除易混淆字符） */
export function generateVerifyCode(length = 8): string {
  let code = "";
  for (let i = 0; i < length; i += 1) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

export function generateOrderNo(): string {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `XY${stamp}${rand}`;
}
