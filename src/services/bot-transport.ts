import { getCachedAppSettings } from "@/database/operations";
import {
  DEFAULT_GLOBAL_PRIVACY,
  DEFAULT_GLOBAL_TRANSPORT,
  PRIVACY_SETTING_KEY,
  TRANSPORT_SETTING_KEYS,
  WEBHOOK_ALLOWED_UPDATES,
  botWebhookSecret,
  botWebhookUrl,
  isEdgeRuntime,
  normalizeGlobalTransport,
  resolveEffectivePrivacy,
  resolveEffectiveTransportWithFallback,
  type EffectiveTransport,
  type GlobalTransportMode,
  type PrivacySetting,
} from "@/lib/telegram/runtime-mode";
import { parseBotProfile, parseBotPrivacyMode } from "@/bot/multi-runtime";

/** 运行时全局配置（app_settings 读取） */
export interface TelegramRuntimeSettings {
  transportMode: GlobalTransportMode;
  webhookBaseUrl: string;
  privacyEnabled: boolean;
}

export async function getTelegramRuntimeSettings(): Promise<TelegramRuntimeSettings> {
  // v2.0.6 D1 优化：原先 3 次 getAppSetting 直读（每 isolate 回收后首条 webhook
  // 都会触发）改为 1 次全量缓存读（120s TTL + 进程内 memo + KV），读行降为 ≈ 0
  const stored = await getCachedAppSettings();
  return {
    transportMode: normalizeGlobalTransport(stored[TRANSPORT_SETTING_KEYS.mode] || undefined),
    webhookBaseUrl: (stored[TRANSPORT_SETTING_KEYS.webhookBaseUrl] ?? "").trim(),
    privacyEnabled:
      stored[PRIVACY_SETTING_KEY] === undefined
        ? DEFAULT_GLOBAL_PRIVACY
        : stored[PRIVACY_SETTING_KEY] !== "false",
  };
}

export interface BotResolvedRuntime {
  mode: EffectiveTransport;
  privacy: boolean;
  webhookUrl: string | null;
}

/** 解析单个机器人的生效运行模式与隐私模式 */
export function resolveBotRuntime(
  botId: string,
  profileRaw: string,
  global: TelegramRuntimeSettings,
): BotResolvedRuntime {
  const profile = parseBotProfile(profileRaw);
  // v2.0.2：默认 Webhook（出站 API 走全局代理，入站由 Telegram 推送到公网回调地址）；
  // Node 未配置 Webhook Base URL 时回退轮询（入站 getUpdates 经代理拉取）
  const mode = resolveEffectiveTransportWithFallback(
    profile.transportMode ?? "inherit",
    global.transportMode,
    isEdgeRuntime(),
    Boolean(global.webhookBaseUrl),
  );
  const privacy = resolveEffectivePrivacy(
    profile.privacyModeSetting ?? "inherit",
    profile.privacyMode,
    global.privacyEnabled,
  );
  return {
    mode,
    privacy,
    webhookUrl: mode === "webhook" && global.webhookBaseUrl ? botWebhookUrl(global.webhookBaseUrl, botId) : null,
  };
}

/**
 * 只读探测该 Token 是否已被「远程环境」的 Webhook 消费者接管（getWebhookInfo，url 非空即存在）。
 *
 * 背景（2026-11-07「线上获取不到新创建的群组」事故根因）：
 * 同一 Bot Token 被本地 Node 环境（长轮询）与线上 Cloudflare Pages（Webhook）共用时，
 * Telegram 侧 getUpdates 与 Webhook 严格互斥 —— 本地启动轮询前 deleteWebhook 会直接
 * 掐断线上事件推送（新群组的 my_chat_member 从此丢失、线上库永远无法登记），且全部
 * 更新被本地轮询吃进本地库。此探测用于本地轮询启动前守卫（见 multi-runtime/runtime）。
 *
 * 可靠性（v2.0.10 实测教训）：沙盒/受限网络下 getWebhookInfo 偶发超时/网络失败 ——
 * 初版「失败=null=放行」策略在探测失败时让本地抢占并删掉线上 Webhook（事故复发）。
 * 现改为失败自动重试（共 3 次尝试，间隔 2s），全部失败才返回 null 并由调用方打
 * 警告日志 —— 显著降低网络抖动导致的误放行。
 */
export async function probeRemoteWebhook(
  token: string,
): Promise<{ url: string; pendingUpdateCount: number } | null> {
  const { tgRawCall } = await import("@/lib/telegram/transport");
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await tgRawCall<{
        ok: boolean;
        result?: { url?: string; pending_update_count?: number };
      }>(token, "getWebhookInfo");
      // 请求成功：明确判定（url 非空 = 远程消费者存在；空 = 无 webhook）
      const url = res?.ok ? (res.result?.url ?? "").trim() : "";
      if (!url) return null;
      return { url, pendingUpdateCount: res?.result?.pending_update_count ?? 0 };
    } catch {
      // 网络失败：重试（最后一次仍失败 → null，调用方按「未探测到」处理并告警）
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }
  return null;
}

/**
 * 注册/更新机器人的 Webhook（setWebhook）或关闭它（deleteWebhook）。
 * 仅在 transport 生效模式变化或首次启用时调用；幂等可重复执行。
 */
export async function applyBotTransport(
  params: { token: string; botId: string },
  mode: EffectiveTransport,
  webhookBaseUrl: string,
): Promise<{ ok: boolean; error?: string; url?: string }> {
  const { botByToken, withTelegramTimeout } = await import("@/services/telegram-sync");
  try {
    const bot = botByToken(params.token);
    if (mode === "webhook") {
      if (!webhookBaseUrl) {
        return { ok: false, error: "未配置 Webhook Base URL（系统设置 → 传输模式）" };
      }
      const url = botWebhookUrl(webhookBaseUrl, params.botId);
      const secret = botWebhookSecret(params.botId, params.token);
      await withTelegramTimeout(
        bot.api.setWebhook(url, {
          secret_token: secret,
          allowed_updates: [...WEBHOOK_ALLOWED_UPDATES],
          drop_pending_updates: false,
        }),
      );
      return { ok: true, url };
    }
    await withTelegramTimeout(bot.api.deleteWebhook({ drop_pending_updates: false }));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 保存全局配置后应用：停掉全部轮询实例 → startMenuBots 按新模式重新拉起（webhook 机器人不再轮询而是注册 Webhook） */
export async function applyGlobalTransportToAll(): Promise<void> {
  const { stopAllMenuBots, startMenuBots } = await import("@/bot/multi-runtime");
  const { stopBotRuntime, startBotRuntime } = await import("@/bot/runtime");
  await stopAllMenuBots().catch((error: unknown) => {
    console.error("[bot-transport] 应用全局传输配置时停止 menu bots 失败:", error);
  });
  await stopBotRuntime().catch((error: unknown) => {
    console.error("[bot-transport] 应用全局传输配置时停止主 bot 失败:", error);
  });
  await startBotRuntime().catch((error: unknown) => {
    console.error("[bot-transport] 应用全局传输配置时重启主 bot 失败，机器人已离线:", error);
  });
  await startMenuBots().catch((error: unknown) => {
    console.error("[bot-transport] 应用全局传输配置时重启 menu bots 失败，机器人已离线:", error);
  });
}

/** 全局隐私模式设置值 */
export async function getGlobalPrivacyEnabled(): Promise<boolean> {
  // v2.0.6 D1 优化：直读改缓存全量读
  const stored = await getCachedAppSettings();
  return stored[PRIVACY_SETTING_KEY] === undefined
    ? DEFAULT_GLOBAL_PRIVACY
    : stored[PRIVACY_SETTING_KEY] !== "false";
}

export function parsePrivacySetting(raw: string | undefined): PrivacySetting {
  return raw === "on" || raw === "off" ? raw : "inherit";
}

export { parseBotProfile, parseBotPrivacyMode, normalizeGlobalTransport, DEFAULT_GLOBAL_TRANSPORT };
