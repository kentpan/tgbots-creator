import { parse } from "smol-toml";
import { getEnvBaseDir } from "@/lib/dotenv";
import { requireNodeBuiltin } from "@/lib/node-runtime";

type FsModule = typeof import("node:fs");
type PathModule = typeof import("node:path");

/**
 * 运行时同步获取 node:fs / node:path（详见 src/lib/node-runtime.ts）。
 * 本模块被几乎所有 server 路由静态引用进入 Edge bundle；静态 import node:fs
 * 会使 Edge 模块求值时 "Native module not found" 炸构建
 * （2026-11-04 GitHub Actions 实测）。eval 逃逸后 bundle 无 node: 静态引用；
 * fs/path 的使用点仅在 Node 形态分支内（loadConfig），Edge 形态不会执行。
 */
function fsModule(): FsModule {
  return requireNodeBuiltin<FsModule>("node:fs");
}

function pathModule(): PathModule {
  return requireNodeBuiltin<PathModule>("node:path");
}

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

/**
 * 从 TOML 数据提取配置（纯函数，无副作用）：
 * 未提供的字段使用内置默认值（bot.token 为空串 = 主 bot 未配置，属正常状态）。
 */
function buildConfig(data: Record<string, Record<string, unknown>>): Config {
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

function loadConfig(configPath = "config.toml"): Config {
  const configFile = pathModule().resolve(getEnvBaseDir(), configPath);
  let raw: string;
  try {
    raw = fsModule().readFileSync(configFile, "utf-8");
  } catch {
    throw new Error(`Configuration file not found: ${configPath}`);
  }

  const data = parse(raw) as unknown as Record<string, Record<string, unknown>>;
  return buildConfig(data);
}

/**
 * 模块顶层配置求值 —— 必须区分运行时形态（与 instrumentation.ts 的
 * NEXT_RUNTIME 防御同一范式）：
 *
 * - Node 形态（本地/沙盒/standalone）：读 config.toml（缺失抛详细错误，
 *   现有行为不变）。
 * - Edge 形态（Cloudflare Pages）：没有文件系统，config.toml 本就不是
 *   该形态的配置载体（运行时配置来自 D1 的 app_settings 与 Pages 环境变量，
 *   见 src/database/client.ts）。构建期 collect page data 会执行本模块顶层
 *   代码，若在 Edge bundle 顶层读 fs 必然
 *   "Failed to collect page data"（2026-11-04 GitHub Actions 实测事故）。
 *   因此 Edge 形态使用纯默认值结构（buildConfig 对空数据即全默认），
 *   不读文件、不静默掩盖任何错误 —— 两形态各自走显式分支。
 */
export const config: Config =
  // v1.1.5: 判定补充 Cloudflare Workers(workerd, OpenNext 部署) —— workerd 下
  // NEXT_RUNTIME 恒为 "nodejs" 但依旧无文件系统(config.toml 不可读, 读了必抛
  // "Configuration file not found" 炸掉整个服务端)。workerd 运行时将
  // navigator.userAgent 固定为 "Cloudflare-Workers", 命中即走 Edge 分支:
  // 纯默认值结构, 运行时配置来自 D1 的 app_settings 与 Pages 环境变量。
  process.env.NEXT_RUNTIME === "edge" ||
  (typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers")
    ? buildConfig({})
    : loadConfig();
