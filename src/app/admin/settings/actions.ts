"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { EDITABLE_SETTINGS } from "@/config/runtime-settings";
import { setAppSetting } from "@/database/operations";
import { logOperation, requirePermission } from "@/lib/auth";
import { TELEGRAM_PROXY_SETTING_KEYS, invalidateTelegramProxyConfig, proxyEnvGateEnabled } from "@/lib/telegram/transport";
import { isEdgeRuntime } from "@/lib/telegram/runtime-mode";

export async function saveSettingsAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("settings:manage");
  const updated: string[] = [];
  for (const setting of EDITABLE_SETTINGS) {
    // 布尔开关：勾选=1 → true，未勾选 → false（必须显式落库，不能跳过）
    if (setting.kind === "boolean") {
      const value = formData.get(setting.key) !== null ? "true" : "false";
      await setAppSetting(setting.key, value);
      updated.push(setting.key);
      continue;
    }
    const raw = formData.get(setting.key);
    if (raw === null) continue;
    const value = String(raw).trim();
    if (setting.kind === "number") {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        redirect(`/admin/settings?error=${encodeURIComponent(setting.key)}`);
      }
    }
    if (!value) continue;
    await setAppSetting(setting.key, value);
    updated.push(setting.key);
  }
  // Telegram 代理设置变更：立即失效传输层缓存，下一次 Bot API 请求即生效（无需重启）
  if (updated.some((key) => key.startsWith("telegram."))) {
    const { invalidateTelegramProxyConfig } = await import("@/lib/telegram/transport");
    invalidateTelegramProxyConfig();
  }
  const requestHeaders = await headers();
  await logOperation(admin, {
    action: "更新系统设置",
    detail: updated.join(", "),
    headers: requestHeaders,
  });
  revalidatePath("/admin/settings");
  redirect("/admin/settings?saved=1");
}

/**
 * v2.2.5 全局代理配置（系统设置 → 全局代理配置模块）：
 * 开关 + 代理 URL + 鉴权头名称 + APIKey。
 * 生效语义：Node 环境必须 .env PROXY_ENABLED==="true" 且本开关同时开启；
 * edge（无 .env）仅认本开关。保存后立即失效传输层缓存（无需重启）。
 */
export async function saveProxySettingsAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("settings:manage");
  const proxyEnabled = formData.get(TELEGRAM_PROXY_SETTING_KEYS.enabled) !== null ? "true" : "false";
  const proxyUrl = String(formData.get(TELEGRAM_PROXY_SETTING_KEYS.url) ?? "").trim();
  const headerName = String(formData.get(TELEGRAM_PROXY_SETTING_KEYS.headerName) ?? "").trim();
  const apikey = String(formData.get(TELEGRAM_PROXY_SETTING_KEYS.apikey) ?? "");

  await setAppSetting(TELEGRAM_PROXY_SETTING_KEYS.enabled, proxyEnabled);
  await setAppSetting(TELEGRAM_PROXY_SETTING_KEYS.url, proxyUrl);
  await setAppSetting(TELEGRAM_PROXY_SETTING_KEYS.headerName, headerName);
  await setAppSetting(TELEGRAM_PROXY_SETTING_KEYS.apikey, apikey);
  invalidateTelegramProxyConfig();

  const requestHeaders = await headers();
  const effective =
    isEdgeRuntime() || proxyEnvGateEnabled() ? (proxyEnabled === "true" ? "已生效" : "已关闭") : "未生效（.env PROXY_ENABLED≠true）";
  await logOperation(admin, {
    action: "更新全局代理配置",
    detail: `enabled=${proxyEnabled}，url=${proxyUrl || "（空→内置默认代理）"}，header=${headerName || "Authorization"}，组合状态=${effective}`,
    headers: requestHeaders,
  });
  revalidatePath("/admin/settings");
  redirect("/admin/settings?proxy_saved=1");
}
