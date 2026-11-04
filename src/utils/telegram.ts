import { createHmac, timingSafeEqual } from "node:crypto";

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

function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function validateInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds = 24 * 60 * 60,
): TelegramWebAppUser | null {
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

  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
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
