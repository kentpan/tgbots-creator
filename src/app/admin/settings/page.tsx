import { config } from "@/config/settings";
import { EDITABLE_SETTINGS } from "@/config/runtime-settings";
import { getDatabaseInfo } from "@/database/client";
import { getKv, getStorage } from "@/database/bindings";
import { getCachedAppSettings, listBots } from "@/database/operations";
import { requirePermission } from "@/lib/auth";
import { DEFAULT_TELEGRAM_PROXY_URL, proxyEnvGateEnabled, TELEGRAM_PROXY_SETTING_KEYS } from "@/lib/telegram/transport";
import {
  isEdgeRuntime,
  normalizeGlobalTransport,
  sanitizeWebhookRoute,
  TRANSPORT_SETTING_KEYS,
  PRIVACY_SETTING_KEY,
} from "@/lib/telegram/runtime-mode";
import { listMenuBotInstances } from "@/bot/multi-runtime";
import { TelegramGlobalCards } from "@/components/admin/telegram-global-cards";
import { SubmitButton } from "@/components/admin/submit-button";
import { SessionStorageCard } from "@/components/admin/session-storage-card";
import { saveProxySettingsAction, saveSettingsAction } from "./actions";
import { getPublicSessionStorageConfig } from "@/bot/session-storage";

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    saved?: string;
    error?: string;
    proxy_saved?: string;
    tg_saved?: string;
    tg_error?: string;
  }>;
}) {
  const admin = await requirePermission("settings:view");
  const params = await searchParams;

  const [stored, dbInfo, bots, sessionStorageConfig] = await Promise.all([
    getCachedAppSettings(),
    getDatabaseInfo(),
    listBots(),
    // v2.0.3：RSC 首屏直传会话存储配置，页面初始加载不再多发一次 GET 请求
    getPublicSessionStorageConfig(),
  ]);
  const kvKind = getKv().kind;
  const storageKind = getStorage().kind;
  const edge = isEdgeRuntime();

  // v2.2.5 Bot 状态真实自动检测（本进程 registry 即运行实例权威）
  const botInstances = listMenuBotInstances();
  const enabledBotCount = bots.filter((bot) => bot.enabled).length;

  // v2.2.5 全局代理配置（真实组合状态检测）
  const proxySettingEnabled = stored[TELEGRAM_PROXY_SETTING_KEYS.enabled] !== "false";
  const envGateOn = proxyEnvGateEnabled();
  const proxyEffective = edge ? proxySettingEnabled : proxySettingEnabled && envGateOn;

  const defaults: Record<string, string> = {
    "bot.verification_timeout": String(config.bot.verificationTimeout),
    "bot.verification_button_text": config.bot.verificationButtonText,
    "api.base_url": config.api.baseUrl,
    "captcha.provider": config.captcha.provider,
    "cleanup.retention_days": String(config.cleanup.retentionDays),
  };
  const webhookRoute = sanitizeWebhookRoute(stored["telegram.webhook_route"]);

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
      {params.proxy_saved ? (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          全局代理配置已保存并即时生效（无需重启）
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

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-xl border bg-card p-4">
          <h2 className="mb-3 text-sm font-semibold">运行环境</h2>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">当前账号</span>
              <span className="font-medium">{admin.user.username}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">运行形态</span>
              <span className="font-medium">{edge ? "Edge（Cloudflare Workers）" : "Node 常驻进程"}</span>
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
          <h2 className="mb-3 text-sm font-semibold">Bot 状态（实时检测）</h2>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">机器人</span>
              <span className="font-medium">
                {bots.length} 个（启用 {enabledBotCount} 个）
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">运行实例（本进程）</span>
              <span className="font-medium">
                {botInstances.presentIds.length} 个
                {botInstances.runningIds.length > 0
                  ? `（轮询中 ${botInstances.runningIds.length} 个）`
                  : ""}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">主 Bot Token</span>
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
              <span className="font-mono">{webhookRoute}</span>
            </div>
          </div>
        </div>
      </div>

      {/* v2.2.5 全局代理配置（开关 + .env PROXY_ENABLED 说明 + URL/鉴权头/APIKey） */}
      <div className="rounded-xl border bg-card p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">全局代理配置</h2>
          <span
            className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
              proxyEffective
                ? "border-green-300 bg-green-50 text-green-700"
                : "border-amber-300 bg-amber-50 text-amber-700"
            }`}
          >
            当前组合状态：{proxyEffective ? "代理已全局生效" : "未生效（直连 api.telegram.org）"}
          </span>
        </div>
        <form action={saveProxySettingsAction} className="space-y-4">
          <div className="rounded-lg border bg-muted/40 p-4 text-sm">
            <p className="font-medium">.env 总开关说明（PROXY_ENABLED）</p>
            <p className="mt-1 text-muted-foreground">
              全站所有对 api.telegram.org 的请求按唯一开关链路生效：
              <span className="mx-1 rounded bg-background px-1 font-mono text-xs">PROXY_ENABLED=true/false</span>
              配置在项目根目录 <span className="font-mono text-xs">.env</span> 文件中。
              <b>Node 环境</b>必须 <span className="font-mono text-xs">PROXY_ENABLED=true</span>{" "}
              且上方开关同时开启才全局走代理；
              <b>Edge/Cloudflare 部署</b>无 .env 文件，仅认上方开关。
              修改 .env 后需重启服务生效；本页开关保存后立即生效（无需重启）。
            </p>
            <p className="mt-2 text-muted-foreground">
              当前自动检测：运行形态 = {edge ? "Edge（无 .env，仅认本页开关）" : "Node"}；
              <span className="font-mono text-xs">PROXY_ENABLED</span> ={" "}
              <span className="font-mono text-xs">{envGateOn ? "true" : (process.env.PROXY_ENABLED ?? "未设置")}</span>
              （{edge ? "本环境不适用" : envGateOn ? "门禁通过" : "门禁拦截：Node 环境代理不会生效"}）
            </p>
          </div>

          <label
            htmlFor={TELEGRAM_PROXY_SETTING_KEYS.enabled}
            className="flex cursor-pointer items-center justify-between rounded-md border border-input bg-background px-4 py-3"
          >
            <span>
              <span className="text-sm font-medium">启用全局代理</span>
              <span className="ml-2 text-sm text-muted-foreground">
                {proxySettingEnabled ? "已开启（所有 api.telegram.org 请求按代理链路）" : "已关闭（全部直连）"}
              </span>
            </span>
            <span className="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full bg-muted transition-colors has-[:checked]:bg-primary">
              <input
                id={TELEGRAM_PROXY_SETTING_KEYS.enabled}
                name={TELEGRAM_PROXY_SETTING_KEYS.enabled}
                type="checkbox"
                value="1"
                defaultChecked={proxySettingEnabled}
                className="peer sr-only"
              />
              <span className="pointer-events-none absolute left-0.5 h-5 w-5 rounded-full bg-background shadow transition-transform peer-checked:translate-x-5" />
            </span>
          </label>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="space-y-1">
              <label htmlFor={TELEGRAM_PROXY_SETTING_KEYS.url} className="block text-sm font-medium">
                代理 URL
              </label>
              <input
                id={TELEGRAM_PROXY_SETTING_KEYS.url}
                name={TELEGRAM_PROXY_SETTING_KEYS.url}
                type="text"
                defaultValue={stored[TELEGRAM_PROXY_SETTING_KEYS.url] ?? DEFAULT_TELEGRAM_PROXY_URL}
                placeholder="https://user:pass@proxy.example.com/p/"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
              />
              <p className="text-sm text-muted-foreground">URL 前缀式转发地址；留空时回退内置默认代理</p>
            </div>
            <div className="space-y-1">
              <label htmlFor={TELEGRAM_PROXY_SETTING_KEYS.headerName} className="block text-sm font-medium">
                鉴权头名称
              </label>
              <input
                id={TELEGRAM_PROXY_SETTING_KEYS.headerName}
                name={TELEGRAM_PROXY_SETTING_KEYS.headerName}
                type="text"
                defaultValue={stored[TELEGRAM_PROXY_SETTING_KEYS.headerName] ?? "Authorization"}
                placeholder="Authorization"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
              />
              <p className="text-sm text-muted-foreground">默认 Authorization</p>
            </div>
            <div className="space-y-1">
              <label htmlFor={TELEGRAM_PROXY_SETTING_KEYS.apikey} className="block text-sm font-medium">
                APIKey
              </label>
              <input
                id={TELEGRAM_PROXY_SETTING_KEYS.apikey}
                name={TELEGRAM_PROXY_SETTING_KEYS.apikey}
                type="text"
                defaultValue={stored[TELEGRAM_PROXY_SETTING_KEYS.apikey] ?? ""}
                placeholder="Bearer "
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
              />
              <p className="text-sm text-muted-foreground">
                默认 Bearer 前缀（如 Bearer abc123）；留空时使用代理地址内嵌凭据（Basic）
              </p>
            </div>
          </div>

          <SubmitButton
            className="inline-flex h-10 items-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            pendingLabel="保存中…"
          >
            保存代理配置
          </SubmitButton>
        </form>
      </div>

      {/* Telegram 传输模式（轮询/Webhook）与隐私模式：全局默认（Tab 切换，自包含组件） */}
      <TelegramGlobalCards
        initialMode={normalizeGlobalTransport(stored[TRANSPORT_SETTING_KEYS.mode])}
        initialWebhookBaseUrl={stored[TRANSPORT_SETTING_KEYS.webhookBaseUrl] ?? ""}
        initialPrivacyEnabled={stored[PRIVACY_SETTING_KEY] === undefined ? true : stored[PRIVACY_SETTING_KEY] !== "false"}
        isEdge={edge}
      />

      {/* BOT 会话数据存储（grammY session 外部存储）：内存 / SQLite / Cloudflare D1 / R2 一键切换 */}
      <SessionStorageCard initialConfig={sessionStorageConfig} />

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
            <SubmitButton
              className="inline-flex h-10 items-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              pendingLabel="保存中…"
            >
              保存设置
            </SubmitButton>
          </div>
        </form>
      </div>
    </div>
  );
}
