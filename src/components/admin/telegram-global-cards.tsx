"use client";

import { useState, useTransition } from "react";
import { SelfContainedTabs } from "@/components/admin/self-contained-tabs";
import {
  savePrivacyGlobalAction,
  saveTelegramTransportGlobalAction,
} from "@/app/admin/settings/telegram-runtime-actions";

/**
 * 全局传输模式（轮询/Webhook/自动）与全局隐私模式配置卡片。
 *
 * v2.0.2 默认策略（grammY 官方 https://grammy.dev/guide/deployment-types）：
 * - 默认（自动）= Webhook：两种环境统一。配置了 Webhook Base URL 后由 Telegram
 *   推送更新（入站经公网/网关进来），Node 环境出站 Bot API 调用自动走全局代理；
 * - Edge / Serverless（Cloudflare Pages 等）没有常驻进程，无法挂起 getUpdates
 *   长轮询，恒为 Webhook；
 * - Node 常驻服务且未配置 Webhook Base URL（Telegram 无法推送进来）→ 自动回退
 *   长轮询：入站更新由 getUpdates 经全局代理拉回，机器人始终在线；
 * - 显式选择长轮询（无需公网 URL）：入站由 getUpdates 经全局代理拉取。
 *
 * 隐私模式：Telegram 侧由 BotFather /setprivacy 控制（API 无修改入口，
 * getMe.can_read_all_group_messages 反映真实状态）。开启后 bot 收不到群内
 * 其他成员的普通消息（命令/回复/@bot 除外）。注意：隐私模式方向是
 * 「bot 看不到用户」，用户→bot 的消息要让群里其他人看不到，唯一方式是
 * 私聊（本项目验证链接 t.me/<bot>?start=<token> 已内置私聊验证通道）。
 */

const inputClass =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
const primaryBtnClass =
  "inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60";

export interface TelegramGlobalCardsProps {
  initialMode: "auto" | "polling" | "webhook";
  initialWebhookBaseUrl: string;
  initialPrivacyEnabled: boolean;
  isEdge: boolean;
}

export function TelegramGlobalCards({
  initialMode,
  initialWebhookBaseUrl,
  initialPrivacyEnabled,
  isEdge,
}: TelegramGlobalCardsProps) {
  const [mode, setMode] = useState<"auto" | "polling" | "webhook">(initialMode);
  const [baseUrl, setBaseUrl] = useState(initialWebhookBaseUrl);
  const [privacy, setPrivacy] = useState(initialPrivacyEnabled);
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  // 自动模式的预期生效值：默认 Webhook；Node 且未填写回调地址时预期回退轮询
  // （保存时留空会自动取站点地址，实际以服务端 resolveEffectiveTransportWithFallback 为准）
  const effectiveMode = mode === "auto" ? (isEdge || baseUrl.trim() ? "webhook" : "polling") : mode;

  const saveTransport = (): void => {
    setStatus(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("mode", mode);
      fd.set("webhookBaseUrl", baseUrl);
      await saveTelegramTransportGlobalAction(fd);
      setStatus({ ok: true, text: `已保存并应用到全部机器人（当前生效：${effectiveMode === "webhook" ? "Webhook" : "轮询"}）` });
    });
  };

  const savePrivacy = (next: boolean): void => {
    setStatus(null);
    setPrivacy(next);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("enabled", next ? "1" : "0");
      await savePrivacyGlobalAction(fd);
      setStatus({ ok: true, text: `全局隐私模式已${next ? "开启" : "关闭"}，运行实例已热更新` });
    });
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* 全局传输模式 */}
      <section className="rounded-xl border bg-card p-4" aria-label="全局传输模式">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold">传输模式（全局默认）</h2>
            <p className="text-xs text-muted-foreground">
              当前运行环境：{isEdge ? "Edge / Serverless（Cloudflare Pages 等）" : "Node 常驻服务"}
              ，生效：<span className="font-medium text-foreground">{effectiveMode === "webhook" ? "Webhook" : "长轮询"}</span>
            </p>
          </div>
        </div>
        <SelfContainedTabs
          ariaLabel="全局传输模式"
          activeKey={mode}
          onActiveKeyChange={(key) => setMode(key as typeof mode)}
          items={[
            {
              key: "auto",
              label: "自动（推荐）",
              content: (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    默认 <b>Webhook</b>（两种环境统一）：配置了 Webhook Base URL 后由 Telegram
                    主动推送更新（入站经公网/网关进来），Node 环境出站 Bot API 调用自动走全局代理，
                    <b>出入站全部经代理链路</b>；Edge/Serverless（无常驻进程）恒为 Webhook。
                    Node 常驻服务且未配置 Webhook Base URL 时自动回退长轮询 ——
                    入站更新由 getUpdates 经全局代理拉回，机器人始终在线。
                  </p>
                  <button type="button" className={primaryBtnClass} disabled={pending} onClick={saveTransport}>
                    {pending ? "保存中…" : "保存“自动”模式"}
                  </button>
                </div>
              ),
            },
            {
              key: "polling",
              label: "长轮询",
              content: (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    bot 主动<b>经全局代理</b>调用 getUpdates 拉取更新（入站更新由代理链路拉回，
                    出站 API 同样走代理）。无需域名与公网 HTTPS，适合本地开发 / 内网 /
                    无法被 Telegram 回调的环境；Edge/Serverless 部署时不可用（运行时强制 Webhook）。
                    {isEdge ? "⚠️ 当前为 Edge 环境，长轮询不可用，实际生效 Webhook。" : ""}
                  </p>
                  <button type="button" className={primaryBtnClass} disabled={pending} onClick={saveTransport}>
                    {pending ? "保存中…" : "保存“长轮询”模式"}
                  </button>
                </div>
              ),
            },
            {
              key: "webhook",
              label: "Webhook",
              content: (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Telegram 主动把更新推送到公网 HTTPS 地址（serverless / Cloudflare Pages
                    的唯一方式；Node 环境下出站 Bot API 调用自动走系统设置中的全局代理）。
                    每个机器人注册
                    <code className="mx-1 rounded bg-muted px-1 font-mono text-xs">
                      {"<Base URL>/api/telegram/webhook/<botId>"}
                    </code>
                    并自动附带独立密钥校验。回调地址需 Telegram 服务器可达（公网域名或经网关转发暴露的 HTTPS 地址）。
                  </p>
                  <div className="space-y-1">
                    <label htmlFor="tg-webhook-base" className="block text-sm font-medium">
                      Webhook Base URL（公网 HTTPS）
                    </label>
                    <input
                      id="tg-webhook-base"
                      className={inputClass}
                      placeholder="https://your-domain.pages.dev"
                      value={baseUrl}
                      onChange={(event) => setBaseUrl(event.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      留空保存时自动取当前站点地址；切换到轮询时自动 deleteWebhook。
                    </p>
                  </div>
                  <button type="button" className={primaryBtnClass} disabled={pending} onClick={saveTransport}>
                    {pending ? "保存中…" : "保存“Webhook”模式"}
                  </button>
                </div>
              ),
            },
          ]}
        />
      </section>

      {/* 全局隐私模式 */}
      <section className="rounded-xl border bg-card p-4" aria-label="全局隐私模式">
        <div className="mb-3">
          <h2 className="text-sm font-semibold">隐私模式（全局默认）</h2>
          <p className="text-xs text-muted-foreground">
            方向是「bot 看不到用户」：开启后 bot 收不到群内其他成员的普通消息（仅 /命令、回复、@bot 等可见）
          </p>
        </div>
        <SelfContainedTabs
          ariaLabel="全局隐私模式"
          activeKey={privacy ? "on" : "off"}
          onActiveKeyChange={(key) => savePrivacy(key === "on")}
          items={[
            {
              key: "on",
              label: "开启（推荐）",
              content: (
                <div className="space-y-2 text-sm">
                  <p className="text-muted-foreground">
                    群内普通消息不再推送给 bot（指令严格匹配 / 前缀）。验证码等敏感交互通过
                    <b> 私聊</b>完成 —— 群里其他人完全看不到用户与 bot 的验证对话。
                  </p>
                  <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                    需要同步到 Telegram 侧：BotFather → /setprivacy → 选择机器人 → Enable
                    （API 无修改入口，getMe.can_read_all_group_messages=false 即已开启）。
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {privacy ? "✅ 当前已开启" : "点击即切换为开启"}
                  </p>
                </div>
              ),
            },
            {
              key: "off",
              label: "关闭",
              content: (
                <div className="space-y-2 text-sm">
                  <p className="text-muted-foreground">
                    bot 接收群内全部消息（指令支持任意位置与 @bot 定向写法）。适合需要监听群消息
                    做统计/关键词回复的机器人；验证场景不建议（验证码可能在群里被别人看到）。
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {!privacy ? "✅ 当前已关闭" : "点击即切换为关闭"}
                  </p>
                </div>
              ),
            },
          ]}
        />
      </section>

      {status ? (
        <div
          role="status"
          className={`lg:col-span-2 rounded-md border px-4 py-3 text-sm ${
            status.ok
              ? "border-green-200 bg-green-50 text-green-700"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {status.text}
        </div>
      ) : null}
    </div>
  );
}
