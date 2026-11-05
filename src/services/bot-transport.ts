import { getAppSetting } from "@/database/operations";
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
  const [modeRaw, baseUrlRaw, privacyRaw] = await Promise.all([
    getAppSetting(TRANSPORT_SETTING_KEYS.mode),
    getAppSetting(TRANSPORT_SETTING_KEYS.webhookBaseUrl),
    getAppSetting(PRIVACY_SETTING_KEY),
  ]);
  return {
    transportMode: normalizeGlobalTransport(modeRaw ?? undefined),
    webhookBaseUrl: (baseUrlRaw ?? "").trim(),
    privacyEnabled: privacyRaw === null || privacyRaw === undefined ? DEFAULT_GLOBAL_PRIVACY : privacyRaw !== "false",
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
  const raw = await getAppSetting(PRIVACY_SETTING_KEY);
  return raw === null || raw === undefined ? DEFAULT_GLOBAL_PRIVACY : raw !== "false";
}

export function parsePrivacySetting(raw: string | undefined): PrivacySetting {
  return raw === "on" || raw === "off" ? raw : "inherit";
}

export { parseBotProfile, parseBotPrivacyMode, normalizeGlobalTransport, DEFAULT_GLOBAL_TRANSPORT };
