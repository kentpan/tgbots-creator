"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { EDITABLE_SETTINGS } from "@/config/runtime-settings";
import { setAppSetting } from "@/database/operations";
import { logOperation, requirePermission } from "@/lib/auth";
import { createDatabaseBackup } from "@/services/database-backup";

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

export async function backupDatabaseAction(): Promise<void> {
  const admin = await requirePermission("settings:manage");
  const backup = await createDatabaseBackup();
  const requestHeaders = await headers();
  await logOperation(admin, {
    action: "创建数据库备份",
    target: backup.key,
    detail: `${(backup.size / 1024).toFixed(1)} KB`,
    headers: requestHeaders,
  });
  revalidatePath("/admin/settings");
  redirect(`/admin/settings?backup=${encodeURIComponent(backup.key)}`);
}

function maskSecret(value: string): string {
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

/**
 * 镜像中继密钥 / 远程同步配置保存（DB app_settings，保存即热生效）：
 * - mode=edge：MIRROR_RELAY_SECRET（app_settings: mirror.relay_secret）
 * - mode=node：SYNC_REMOTE_URL + SYNC_REMOTE_SECRET（sync.remote_url / sync.remote_secret）
 * 留空的字段保持原值不动。
 */
export async function saveMirrorSecretAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("settings:manage");
  const mode = String(formData.get("mode") ?? "").trim();
  const updated: string[] = [];

  if (mode === "edge") {
    const secret = String(formData.get("mirror_relay_secret") ?? "").trim();
    if (secret) {
      if (secret.length < 16) {
        redirect("/admin/settings?mirror_error=short-secret");
      }
      await setAppSetting("mirror.relay_secret", secret);
      updated.push(`mirror.relay_secret=${maskSecret(secret)}`);
    }
  } else if (mode === "node") {
    const url = String(formData.get("sync_remote_url") ?? "").trim().replace(/\/+$/, "");
    if (url) {
      if (!/^https?:\/\//i.test(url)) {
        redirect("/admin/settings?mirror_error=bad-url");
      }
      await setAppSetting("sync.remote_url", url);
      updated.push(`sync.remote_url=${url}`);
    }
    const secret = String(formData.get("sync_remote_secret") ?? "").trim();
    if (secret) {
      if (secret.length < 16) {
        redirect("/admin/settings?mirror_error=short-secret");
      }
      await setAppSetting("sync.remote_secret", secret);
      updated.push(`sync.remote_secret=${maskSecret(secret)}`);
    }
  } else {
    redirect("/admin/settings?mirror_error=bad-mode");
  }

  const requestHeaders = await headers();
  await logOperation(admin, {
    action: mode === "edge" ? "更新镜像中继密钥" : "更新远程同步配置",
    detail: updated.length > 0 ? updated.join(", ") : "无字段变更",
    headers: requestHeaders,
  });
  revalidatePath("/admin/settings");
  redirect("/admin/settings?mirror_saved=1");
}
