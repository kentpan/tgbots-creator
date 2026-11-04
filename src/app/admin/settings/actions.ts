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
