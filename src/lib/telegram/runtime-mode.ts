/**
 * 机器人运行模式与隐私模式的解析规则（纯函数，client/server 通用）
 *
 * 权威依据：
 * - grammY 官方文档《Long Polling vs. Webhooks》
 *   (https://grammy.dev/guide/deployment-types)：
 *   Webhooks 适合 serverless 平台（cloud functions / programmable edge networks，
 *   即 Cloudflare Pages/Workers）；长轮询适合本地开发与常驻服务器。
 *
 * v2.0.2 默认策略（两种环境统一）：
 * - 默认传输模式 = Webhook：
 *   edge/serverless 没有常驻进程，无法挂起 30s+ 的 getUpdates 长轮询，Webhook 是
 *   唯一可行方式；Node 常驻服务在配置了 Webhook Base URL 后同样默认 Webhook ——
 *   入站更新由 Telegram 推送到公网回调地址（部署方经网关/公网暴露），出站 Bot API
 *   调用走全局代理，出入站全部经代理链路。
 * - Node 未配置 Webhook Base URL（Telegram 无法推送进来）时自动回退长轮询：
 *   入站更新由 getUpdates 经全局代理拉回，出站 API 调用走代理 —— 机器人始终在线。
 * - 显式配置（单项/全局选 polling）始终优先于默认值。
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

/** 全局传输模式默认值：auto = 默认 Webhook（Node 未配置 Webhook Base URL 时回退轮询） */
export const DEFAULT_GLOBAL_TRANSPORT: GlobalTransportMode = "auto";
/** 全局隐私模式默认值：开启（bot 不收群内普通消息，配合私聊验证实现对外不可见） */
export const DEFAULT_GLOBAL_PRIVACY = true;

export function normalizeGlobalTransport(raw: string | undefined | null): GlobalTransportMode {
  const value = (raw ?? "").trim().toLowerCase();
  return value === "polling" || value === "webhook" ? value : "auto";
}

export function isEdgeRuntime(): boolean {
  // v1.1.5: 补充 workerd 判定 —— OpenNext(@opennextjs/cloudflare) 部署下
  // NEXT_RUNTIME 恒为 "nodejs", 但 Cloudflare Workers/Pages 依旧是无常驻进程的
  // serverless 环境(无法 30s+ 长轮询), 必须继续走 Webhook。workerd 运行时
  // navigator.userAgent 固定为 "Cloudflare-Workers"(官方 Runtime API 文档)。
  if (process.env.NEXT_RUNTIME === "edge") return true;
  return typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
}

/**
 * 解析生效的传输模式（v2.0.2：默认 Webhook，Node/Edge 统一口径）。
 * - 单项显式配置（polling/webhook）优先
 * - 其次全局模式（polling/webhook）
 * - inherit + auto → Webhook
 *
 * 部署形态兜底（Node 未配置 Webhook Base URL 回退轮询）见
 * resolveEffectiveTransportWithFallback()。
 */
export function resolveEffectiveTransport(
  setting: TransportSetting,
  globalMode: GlobalTransportMode,
): EffectiveTransport {
  if (setting === "polling" || setting === "webhook") return setting;
  if (globalMode === "polling" || globalMode === "webhook") return globalMode;
  return "webhook";
}

/**
 * 解析生效传输模式并应用部署形态兜底（启动/热更新入口统一使用本函数）：
 * - Edge/Serverless：恒 Webhook（无常驻进程，长轮询物理不可行）—— 即使显式配置了
 *   polling 也强制改为 Webhook（与设置页「Edge 环境强制 Webhook」文案一致）。
 *   Base URL 缺失时同样保持 Webhook —— 注册失败会在 applyBotTransport 显式报错，
 *   提示必须配置 Telegram 可达的公网回调地址。
 * - Node 常驻服务：默认 Webhook；未配置 Webhook Base URL（Telegram 无法推送）
 *   → 回退长轮询：入站 getUpdates 经全局代理拉取 + 出站 API 走代理，
 *   与 Webhook 形态一样保证「出入站全部走配置的全局代理」。
 */
export function resolveEffectiveTransportWithFallback(
  setting: TransportSetting,
  globalMode: GlobalTransportMode,
  edge: boolean,
  webhookBaseUrlConfigured: boolean,
): EffectiveTransport {
  // Edge/Serverless：长轮询物理不可行，任何显式/默认配置下强制 Webhook
  if (edge) return "webhook";
  const mode = resolveEffectiveTransport(setting, globalMode);
  if (mode === "webhook" && !webhookBaseUrlConfigured) return "polling";
  return mode;
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
