import { timingSafeEqual } from "@/utils/crypto";

export interface TelegramWebAppUser {
  id: number;
  is_bot?: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  photo_url?: string;
}

const encoder = new TextEncoder();

/**
 * HMAC-SHA256（WebCrypto 标准接口，Node 22+ 全局可用，Edge/Node 双形态一致）。
 * 结果与 node:crypto createHmac 逐字节一致。
 *
 * 为什么不再用 node:crypto：其静态 import 会使 Edge bundle 模块求值时
 * "Native module not found: node:crypto" 构建失败（2026-11-04 GitHub Actions 实测）；
 * 而 WebCrypto 的 HMAC 是异步 API，validateInitData 因此改为 async
 * （唯一调用点 /api/v1/verify/route.ts 位于 async 上下文，已同步改为 await）。
 */
async function hmacSha256(key: Uint8Array | string, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? encoder.encode(key) : new Uint8Array(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
  return new Uint8Array(signature);
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export async function validateInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds = 24 * 60 * 60,
): Promise<TelegramWebAppUser | null> {
  if (!initData || !botToken) {
    return null;
  }

  const fields = new URLSearchParams(initData);
  if ([...fields.keys()].some((key) => key === "")) {
    return null;
  }

  const receivedHash = fields.get("hash");
  if (!receivedHash) {
    return null;
  }
  fields.delete("hash");

  const dataCheckString = [...fields.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  // Telegram WebApp initData 校验（官方算法）：
  // secret_key = HMAC-SHA256(key="WebAppData", message=bot_token)
  // expected   = HMAC-SHA256(key=secret_key,  message=data_check_string) 的 hex
  const secretKey = await hmacSha256("WebAppData", botToken);
  const expectedHash = toHex(await hmacSha256(secretKey, dataCheckString));
  if (!timingSafeCompare(expectedHash, receivedHash)) {
    return null;
  }

  const authDate = Number(fields.get("auth_date"));
  const userRaw = fields.get("user");
  if (!Number.isInteger(authDate) || authDate <= 0 || !userRaw) {
    return null;
  }

  if (Date.now() / 1000 - authDate > maxAgeSeconds) {
    return null;
  }

  let user: TelegramWebAppUser;
  try {
    user = JSON.parse(userRaw) as TelegramWebAppUser;
  } catch {
    return null;
  }

  if (!user || typeof user !== "object" || !Number.isInteger(user.id)) {
    return null;
  }

  return user;
}
