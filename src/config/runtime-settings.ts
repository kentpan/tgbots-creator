import type { Config } from "@/config/settings";
import { getCachedAppSettings, setAppSetting } from "@/database/operations";

export interface RuntimeSettings {
  botToken: string;
  verificationTimeout: number;
  verificationButtonText: string;
  baseUrl: string;
  captchaProvider: string;
  cleanupRetentionDays: number;
  apiEnabled: boolean;
}

export const APP_SETTING_KEYS = {
  verificationTimeout: "bot.verification_timeout",
  verificationButtonText: "bot.verification_button_text",
  baseUrl: "api.base_url",
  captchaProvider: "captcha.provider",
  cleanupRetentionDays: "cleanup.retention_days",
  telegramProxyEnabled: "telegram.proxy_enabled",
  telegramProxyUrl: "telegram.proxy_url",
} as const;

export const EDITABLE_SETTINGS: {
  key: string;
  label: string;
  description: string;
  kind: "boolean" | "number" | "text" | "select";
  options?: string[];
}[] = [
  {
    key: APP_SETTING_KEYS.verificationTimeout,
    label: "验证超时（秒）",
    description: "新成员验证链接的有效时长",
    kind: "number",
  },
  {
    key: APP_SETTING_KEYS.verificationButtonText,
    label: "验证按钮文案",
    description: "Bot 发送的验证按钮文字",
    kind: "text",
  },
  {
    key: APP_SETTING_KEYS.baseUrl,
    label: "站点 Base URL",
    description: "Mini Web App 验证页面的访问地址",
    kind: "text",
  },
  {
    key: APP_SETTING_KEYS.captchaProvider,
    label: "验证码驱动",
    description: "人机验证服务商",
    kind: "select",
    options: ["hcaptcha", "cap", "turnstile"],
  },
  {
    key: APP_SETTING_KEYS.cleanupRetentionDays,
    label: "记录保留天数",
    description: "过期验证记录的保留天数",
    kind: "number",
  },
  {
    key: APP_SETTING_KEYS.telegramProxyEnabled,
    label: "Telegram API 代理（Node）",
    description:
      "Node 环境通过 HTTP 前缀代理连接 api.telegram.org（代理网络失败自动回退直连；Cloudflare 部署始终直连，不受本项影响）",
    kind: "boolean",
  },
  {
    key: APP_SETTING_KEYS.telegramProxyUrl,
    label: "Telegram 代理地址（URL 前缀）",
    description:
      "代理前缀，内含 Basic 鉴权（用户名:密码@主机/路径）；最终请求为 <前缀>https://api.telegram.org/...，保存后立即生效无需重启",
    kind: "text",
  },
];

function toNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function getRuntimeSettings(config: Config): Promise<RuntimeSettings> {
  const stored = await getCachedAppSettings();
  return {
    botToken: config.bot.token,
    verificationTimeout: toNumber(
      stored[APP_SETTING_KEYS.verificationTimeout],
      config.bot.verificationTimeout,
    ),
    verificationButtonText:
      stored[APP_SETTING_KEYS.verificationButtonText] ?? config.bot.verificationButtonText,
    baseUrl: stored[APP_SETTING_KEYS.baseUrl] ?? config.api.baseUrl,
    captchaProvider: stored[APP_SETTING_KEYS.captchaProvider] ?? config.captcha.provider,
    cleanupRetentionDays: toNumber(
      stored[APP_SETTING_KEYS.cleanupRetentionDays],
      config.cleanup.retentionDays,
    ),
    apiEnabled: config.api.enable,
  };
}

export async function updateRuntimeSetting(key: string, value: string): Promise<void> {
  await setAppSetting(key, value);
}
