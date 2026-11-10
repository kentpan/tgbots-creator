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
  /** v2.2.5：Webhook 回调路由（默认 /api/telegram/webhook） */
  telegramWebhookRoute: "telegram.webhook_route",
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
    key: APP_SETTING_KEYS.telegramWebhookRoute,
    label: "Webhook 路由",
    description:
      "注册到 Telegram 的回调路径，默认 /api/telegram/webhook（完整 URL = Webhook Base URL + 本路由 + /<botId>）；自定义路径需反向代理映射到应用的同路径",
    kind: "text",
  },
  // v2.0.15：Telegram 代理配置（telegram.proxy_enabled / telegram.proxy_url）已从系统设置
  // 迁移到「机器人测试 → 仿真屏盾牌图标 → 代理偏好设置」面板（APP 风格，含连通性测试与
  // 线上 Edge 站代理一键接入），仍存储于同一批 app_settings 键，历史配置无损迁移。
  // v2.2.5：全局代理配置模块重新回到系统设置页（开关 + URL + 鉴权头名 + APIKey，
  // 详见设置页内 .env PROXY_ENABLED 说明），与仿真屏面板共用同一批键。
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
