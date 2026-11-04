/**
 * 机器人运行模式与隐私模式的解析规则（纯函数，client/server 通用）
 *
 * 权威依据：
 * - grammY 官方文档《Long Polling vs. Webhooks》
 *   (https://grammy.dev/guide/deployment-types)：
 *   长轮询适合本地开发与常驻服务器；Webhooks 适合 serverless 平台
 *   （cloud functions / programmable edge networks，即 Cloudflare Pages/Workers）。
 *   → edge/serverless 环境没有常驻进程，无法挂起 30s+ 的 getUpdates 长轮询，
 *     只能使用 Webhook（本函数对 edge 强制返回 webhook）。
 * - grammY 官方文档《代理支持》(https://grammy.dev/zh/advanced/proxy)：
 *   Node 通过自定义请求执行方式（agent / 自定义 fetch）接入代理；
 *   本项目用 client.fetch 注入前缀代理 fetch（仅 Node），edge 直连无需代理。
 */

export type TransportSetting = "inherit" | "polling" | "webhook";
export type GlobalTransportMode = "auto" | "polling" | "webhook";
export type EffectiveTransport = "polling" | "webhook";

export type PrivacySetting = "inherit" | "on" | "off";

export const TRANSPORT_SETTING_KEYS = {
  mode: "telegram.transport_mode",
  webhookBaseUrl: "telegram.webhook_base_url",
} as const;

export const PRIVACY_SETTING_KEY = "bot.privacy_mode";

/** 全局传输模式默认值：auto = Node 用轮询，edge 用 Webhook */
export const DEFAULT_GLOBAL_TRANSPORT: GlobalTransportMode = "auto";
/** 全局隐私模式默认值：开启（bot 不收群内普通消息，配合私聊验证实现对外不可见） */
export const DEFAULT_GLOBAL_PRIVACY = true;

export function normalizeGlobalTransport(raw: string | undefined | null): GlobalTransportMode {
  const value = (raw ?? "").trim().toLowerCase();
  return value === "polling" || value === "webhook" ? value : "auto";
}

export function isEdgeRuntime(): boolean {
  return process.env.NEXT_RUNTIME === "edge";
}

/**
 * 解析生效的传输模式。
 * - 单项显式配置（polling/webhook）优先
 * - 其次全局模式（polling/webhook）
 * - inherit + auto：Node → 轮询；edge → Webhook（强制，serverless 无法长轮询）
 */
export function resolveEffectiveTransport(
  setting: TransportSetting,
  globalMode: GlobalTransportMode,
  edge: boolean,
): EffectiveTransport {
  if (setting === "polling" || setting === "webhook") return setting;
  if (globalMode === "polling" || globalMode === "webhook") return globalMode;
  return edge ? "webhook" : "polling";
}

/** 解析生效的隐私模式：单项显式 > 旧布尔字段 > 全局默认（开启） */
export function resolveEffectivePrivacy(
  setting: PrivacySetting,
  legacyBoolean: boolean | undefined,
  globalEnabled: boolean,
): boolean {
  if (setting === "on") return true;
  if (setting === "off") return false;
  if (legacyBoolean !== undefined) return legacyBoolean;
  return globalEnabled;
}

/** per-bot Webhook 回调地址：<base>/api/telegram/webhook/<botId>（botId 为数字 id 或 "main"） */
export function botWebhookPath(botId: string): string {
  return `/api/telegram/webhook/${botId}`;
}

export function botWebhookUrl(baseUrl: string, botId: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return `${trimmed}${botWebhookPath(botId)}`;
}

/** per-bot Webhook 密钥（确定性派生，A-Za-z0-9，1-256 字符，Telegram 校验头 x-telegram-bot-api-secret-token） */
export function botWebhookSecret(botId: string, token: string): string {
  // FNV-1a 32bit x2 → 16 位大写字母数字（避免引入 node:crypto 依赖，保持 client/server 通用）
  const input = `tguard:${botId}:${token}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    h1 = (h1 ^ code) >>> 0;
    h1 = (h1 * 0x01000193) >>> 0;
    h2 = (h2 + code * (i + 7)) >>> 0;
    h2 = (h2 ^ (h2 << 13)) >>> 0;
  }
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghijkmnpqrstuvwxyz";
  let secret = "";
  let mixed = (h1 ^ h2) >>> 0;
  for (let i = 0; i < 24; i++) {
    secret += alphabet[mixed % alphabet.length];
    mixed = (mixed * 1664525 + 1013904223 + i) >>> 0;
  }
  return secret;
}

/** setWebhook 允许的更新类型（与轮询消费一致 + 菜单按钮所需的 callback_query） */
export const WEBHOOK_ALLOWED_UPDATES = [
  "message",
  "channel_post",
  "callback_query",
  "my_chat_member",
  "chat_member",
  "chat_join_request",
] as const;

/**
 * 轮询（getUpdates）显式声明的更新类型（v1.1.3）：
 * 与 webhook 列表保持一致。必须显式传入 bot.start()，否则生效的是 Telegram 侧
 * 上一次 setWebhook/getUpdates 遗留的 allowed_updates（可能缺失 chat_member /
 * callback_query，导致直连入群防线收不到事件、内联按钮失灵）。
 */
export const POLLING_ALLOWED_UPDATES = WEBHOOK_ALLOWED_UPDATES;
