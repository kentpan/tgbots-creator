import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";
import { getEnvBaseDir } from "@/lib/dotenv";

export interface BotConfig {
  token: string;
  verificationTimeout: number;
  verificationButtonText: string;
  adminIds: number[];
}

export interface DatabaseConfig {
  host: string;
  port: number;
  name: string;
  user: string;
  password: string;
  minSize: number;
  maxSize: number;
}

export interface CaptchaProviderConfig {
  siteKey: string;
  secretKey: string;
}

export interface CapCaptchaConfig extends CaptchaProviderConfig {
  serverUrl: string;
}

export interface CaptchaConfig {
  provider: string;
  expireMinutes: number;
  timeoutSeconds: number;
  hcaptcha: CaptchaProviderConfig;
  cap: CapCaptchaConfig;
  turnstile: CaptchaProviderConfig;
}

export interface APIConfig {
  host: string;
  port: number;
  baseUrl: string;
  enable: boolean;
  apiKey: string;
}

export interface CleanupConfig {
  retentionDays: number;
}

export interface Config {
  bot: BotConfig;
  database: DatabaseConfig;
  captcha: CaptchaConfig;
  api: APIConfig;
  cleanup: CleanupConfig;
}

function section(
  data: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = data[key];
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function loadConfig(configPath = "config.toml"): Config {
  const configFile = path.resolve(getEnvBaseDir(), configPath);
  let raw: string;
  try {
    raw = readFileSync(configFile, "utf-8");
  } catch {
    throw new Error(`Configuration file not found: ${configPath}`);
  }

  const data = parse(raw) as unknown as Record<string, Record<string, unknown>>;
  const bot = section(data, "bot");
  const database = section(data, "database");
  const captcha = section(data, "captcha");
  const api = section(data, "api");
  const cleanup = section(data, "cleanup");
  const hcaptcha = section(captcha, "hcaptcha");
  const cap = section(captcha, "cap");
  const turnstile = section(captcha, "turnstile");

  return {
    bot: {
      token: String(bot.token ?? ""),
      verificationTimeout: Number(bot.verification_timeout ?? 300),
      verificationButtonText: String(bot.verification_button_text ?? "🔐 开始验证"),
      adminIds: (bot.admin_ids as number[] | undefined) ?? [],
    },
    database: {
      host: String(database.host ?? "localhost"),
      port: Number(database.port ?? 5432),
      name: String(database.name ?? "tguard"),
      user: String(database.user ?? "postgres"),
      password: String(database.password ?? ""),
      minSize: Number(database.min_size ?? 1),
      maxSize: Number(database.max_size ?? 10),
    },
    captcha: {
      provider: String(captcha.provider ?? "hcaptcha").toLowerCase(),
      expireMinutes: Number(captcha.expire_minutes ?? 10),
      timeoutSeconds: Number(captcha.timeout_seconds ?? 30),
      hcaptcha: {
        siteKey: String(hcaptcha.site_key ?? ""),
        secretKey: String(hcaptcha.secret_key ?? ""),
      },
      cap: {
        serverUrl: String(cap.server_url ?? ""),
        siteKey: String(cap.site_key ?? ""),
        secretKey: String(cap.secret_key ?? ""),
      },
      turnstile: {
        siteKey: String(turnstile.site_key ?? ""),
        secretKey: String(turnstile.secret_key ?? ""),
      },
    },
    api: {
      host: String(api.host ?? "0.0.0.0"),
      port: Number(api.port ?? 3000),
      baseUrl: String(api.base_url ?? "http://localhost:3000"),
      enable: Boolean(api.enable ?? false),
      apiKey: String(api.api_key ?? ""),
    },
    cleanup: {
      retentionDays: Number(cleanup.retention_days ?? 30),
    },
  };
}

export const config: Config = loadConfig();
