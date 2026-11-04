import { config } from "@/config/settings";
import { EDITABLE_SETTINGS } from "@/config/runtime-settings";
import { getDatabaseInfo } from "@/database/client";
import { getKv, getStorage } from "@/database/bindings";
import { getCachedAppSettings } from "@/database/operations";
import { requirePermission } from "@/lib/auth";
import { DEFAULT_TELEGRAM_PROXY_URL } from "@/lib/telegram/transport";
import {
  isEdgeRuntime,
  normalizeGlobalTransport,
  TRANSPORT_SETTING_KEYS,
  PRIVACY_SETTING_KEY,
} from "@/lib/telegram/runtime-mode";
import { TelegramGlobalCards } from "@/components/admin/telegram-global-cards";
import { SessionStorageCard } from "@/components/admin/session-storage-card";
import { backupDatabaseAction, saveSettingsAction } from "./actions";
import { listDatabaseBackups } from "@/services/database-backup";

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    saved?: string;
    error?: string;
    backup?: string;
    tg_saved?: string;
    tg_error?: string;
  }>;
}) {
  const admin = await requirePermission("settings:view");
  const params = await searchParams;

  const [stored, dbInfo, backups] = await Promise.all([
    getCachedAppSettings(),
    getDatabaseInfo(),
    listDatabaseBackups(),
  ]);
  const kvKind = getKv().kind;
  const storageKind = getStorage().kind;

  const defaults: Record<string, string> = {
    "bot.verification_timeout": String(config.bot.verificationTimeout),
    "bot.verification_button_text": config.bot.verificationButtonText,
    "api.base_url": config.api.baseUrl,
    "captcha.provider": config.captcha.provider,
    "cleanup.retention_days": String(config.cleanup.retentionDays),
    "telegram.proxy_enabled": "true",
    "telegram.proxy_url": DEFAULT_TELEGRAM_PROXY_URL,
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">系统设置</h1>
        <p className="text-sm text-muted-foreground">
          运行参数保存在数据库 app_settings 表中，未覆盖的项回退到 config.toml 默认值。
        </p>
      </div>

      {params.saved ? (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          设置已保存
        </div>
      ) : null}
      {params.error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          参数 {params.error} 不合法，请填写正数
        </div>
      ) : null}
      {params.backup ? (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          备份已写入对象存储：<span className="font-mono">{params.backup}</span>
        </div>
      ) : null}
      {params.tg_saved ? (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          {params.tg_saved === "transport"
            ? "全局传输模式已保存并应用到全部机器人（长轮询/Webhook 自动切换）"
            : "全局隐私模式已保存，运行实例已热更新"}
        </div>
      ) : null}
      {params.tg_error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {params.tg_error === "webhook-base-url-https"
            ? "Webhook Base URL 必须是公网 https:// 地址"
            : "Telegram 配置不合法，请检查后重试"}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-xl border bg-card p-4">
          <h2 className="mb-3 text-sm font-semibold">运行环境</h2>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">当前账号</span>
              <span className="font-medium">{admin.user.username}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">SQL 数据层</span>
              <span className="font-medium">
                {dbInfo.kind === "d1" ? "Cloudflare D1" : "node:sqlite"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">KV 缓存</span>
              <span className="font-medium">
                {kvKind === "cloudflare" ? "Cloudflare KV" : "内存缓存"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">对象存储</span>
              <span className="font-medium">
                {storageKind === "cloudflare-r2" ? "Cloudflare R2" : "本地 .data/storage"}
              </span>
            </div>
          </div>
        </div>

        <div className="rounded-xl border bg-card p-4">
          <h2 className="mb-3 text-sm font-semibold">Bot 状态</h2>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Bot Token</span>
              <span className="font-medium">{config.bot.token ? "已配置" : "未配置"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Telegram 管理员</span>
              <span className="font-medium">{config.bot.adminIds.length} 人</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">外部 API</span>
              <span className="font-medium">{config.api.enable ? "已启用" : "未启用"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Webhook 路由</span>
              <span className="font-mono">/api/telegram/webhook</span>
            </div>
          </div>
        </div>

        <div className="rounded-xl border bg-card p-4">
          <h2 className="mb-3 text-sm font-semibold">数据库备份</h2>
          <form action={backupDatabaseAction}>
            <button
              type="submit"
              className="inline-flex h-10 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent"
            >
              立即备份到对象存储
            </button>
          </form>
          <div className="mt-3 space-y-1">
            {backups.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无备份记录</p>
            ) : (
              backups.map((backup) => (
                <p key={backup.key} className="truncate text-sm font-mono" title={backup.key}>
                  {backup.key}（{(backup.size / 1024).toFixed(1)} KB）
                </p>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Telegram 传输模式（轮询/Webhook）与隐私模式：全局默认（Tab 切换，自包含组件） */}
      <TelegramGlobalCards
        initialMode={normalizeGlobalTransport(stored[TRANSPORT_SETTING_KEYS.mode])}
        initialWebhookBaseUrl={stored[TRANSPORT_SETTING_KEYS.webhookBaseUrl] ?? ""}
        initialPrivacyEnabled={stored[PRIVACY_SETTING_KEY] === undefined ? true : stored[PRIVACY_SETTING_KEY] !== "false"}
        isEdge={isEdgeRuntime()}
      />

      {/* BOT 会话数据存储（grammY session 外部存储）：内存 / SQLite / Cloudflare D1 / R2 一键切换 */}
      <SessionStorageCard />

      <div className="rounded-xl border bg-card p-6">
        <h2 className="mb-4 text-lg font-semibold">运行参数</h2>
        <form action={saveSettingsAction} className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {EDITABLE_SETTINGS.map((setting) => (
            <div key={setting.key} className="space-y-1">
              <label htmlFor={setting.key} className="block text-sm font-medium">
                {setting.label}
                <span className="ml-2 font-mono text-muted-foreground">{setting.key}</span>
              </label>
              {setting.kind === "boolean" ? (
                <label
                  htmlFor={setting.key}
                  className="flex h-10 cursor-pointer items-center justify-between rounded-md border border-input bg-background px-3"
                >
                  <span className="text-sm text-muted-foreground">
                    {(stored[setting.key] ?? defaults[setting.key] ?? "true") === "false"
                      ? "已关闭（直连 api.telegram.org）"
                      : "已开启（默认）"}
                  </span>
                  <span className="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full bg-muted transition-colors has-[:checked]:bg-primary">
                    <input
                      id={setting.key}
                      name={setting.key}
                      type="checkbox"
                      value="1"
                      defaultChecked={(stored[setting.key] ?? defaults[setting.key] ?? "true") !== "false"}
                      className="peer sr-only"
                    />
                    <span className="pointer-events-none absolute left-0.5 h-5 w-5 rounded-full bg-background shadow transition-transform peer-checked:translate-x-5" />
                  </span>
                </label>
              ) : setting.kind === "select" ? (
                <select
                  id={setting.key}
                  name={setting.key}
                  defaultValue={stored[setting.key] ?? defaults[setting.key] ?? ""}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  {(setting.options ?? []).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={setting.key}
                  name={setting.key}
                  type={setting.kind === "number" ? "number" : "text"}
                  min={setting.kind === "number" ? 1 : undefined}
                  defaultValue={stored[setting.key] ?? defaults[setting.key] ?? ""}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              )}
              <p className="text-sm text-muted-foreground">{setting.description}</p>
            </div>
          ))}
          <div className="md:col-span-2">
            <button
              type="submit"
              className="inline-flex h-10 items-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              保存设置
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
