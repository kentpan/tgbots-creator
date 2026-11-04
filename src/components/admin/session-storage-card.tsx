"use client";

import { useEffect, useState } from "react";

/**
 * BOT 会话存储配置卡片（自包含）：
 * 一键 switch 切换 grammY session 存储后端（内存 / SQLite / Cloudflare D1 / Cloudflare R2），
 * D1/R2 支持 edge binding 自动探测与 REST API 两种接入方式，可对目标后端做连通性测试。
 */

interface StorageConfigState {
  backend: string;
  sqlite_sessions: number;
  d1: { account_id: string; database_id: string; api_token_masked: string; has_api_token: boolean };
  r2: { account_id: string; access_key_id: string; secret_masked: string; has_secret: boolean; bucket: string; cdn_url: string };
  s3: {
    endpoint: string;
    region: string;
    bucket: string;
    access_key_id: string;
    secret_masked: string;
    has_secret: boolean;
    path_style: string;
    cdn_url: string;
  };
}

const BACKENDS = [
  { value: "memory", label: "内存（默认，重启丢失）", icon: "⚡" },
  { value: "sqlite", label: "SQLite（本地 bot_sessions 表）", icon: "💾" },
  { value: "d1", label: "Cloudflare D1", icon: "☁️" },
  { value: "r2", label: "Cloudflare R2", icon: "🪣" },
  { value: "s3", label: "S3 兼容对象存储（AWS / MinIO / 通用）", icon: "🗄️" },
] as const;

const inputClass =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none transition focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30";

export function SessionStorageCard() {
  const [config, setConfig] = useState<StorageConfigState | null>(null);
  const [backend, setBackend] = useState("memory");
  const [d1, setD1] = useState({ account_id: "", database_id: "", api_token: "" });
  const [r2, setR2] = useState({ account_id: "", access_key_id: "", secret_access_key: "", bucket: "", cdn_url: "" });
  const [s3, setS3] = useState({
    endpoint: "",
    region: "us-east-1",
    bucket: "",
    access_key_id: "",
    secret_access_key: "",
    path_style: "path",
    cdn_url: "",
  });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/admin/session-storage");
        const payload = (await response.json()) as { ok: boolean; data?: StorageConfigState };
        if (payload.ok && payload.data) {
          setConfig(payload.data);
          setBackend(payload.data.backend);
          setD1((prev) => ({
            ...prev,
            account_id: payload.data!.d1.account_id,
            database_id: payload.data!.d1.database_id,
          }));
          setR2((prev) => ({
            ...prev,
            account_id: payload.data!.r2.account_id,
            access_key_id: payload.data!.r2.access_key_id,
            bucket: payload.data!.r2.bucket,
            cdn_url: payload.data!.r2.cdn_url ?? "",
          }));
          setS3((prev) => ({
            ...prev,
            endpoint: payload.data!.s3.endpoint || prev.endpoint,
            region: payload.data!.s3.region || prev.region,
            bucket: payload.data!.s3.bucket,
            access_key_id: payload.data!.s3.access_key_id,
            path_style: payload.data!.s3.path_style || prev.path_style,
            cdn_url: payload.data!.s3.cdn_url ?? "",
          }));
        }
      } catch {
        /* 首次加载失败静默 */
      }
    })();
  }, []);

  const save = async (): Promise<void> => {
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/session-storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          backend,
          d1: {
            account_id: d1.account_id,
            database_id: d1.database_id,
            ...(d1.api_token.trim() ? { api_token: d1.api_token } : {}),
          },
          r2: {
            account_id: r2.account_id,
            access_key_id: r2.access_key_id,
            ...(r2.secret_access_key.trim() ? { secret_access_key: r2.secret_access_key } : {}),
            bucket: r2.bucket,
            cdn_url: r2.cdn_url,
          },
          s3: {
            endpoint: s3.endpoint,
            region: s3.region,
            bucket: s3.bucket,
            access_key_id: s3.access_key_id,
            ...(s3.secret_access_key.trim() ? { secret_access_key: s3.secret_access_key } : {}),
            path_style: s3.path_style,
            cdn_url: s3.cdn_url,
          },
        }),
      });
      const payload = (await response.json()) as { ok: boolean; error?: string };
      if (payload.ok) {
        setMessage({
          kind: "ok",
          text: "存储配置已保存。新配置对之后启动/重启的机器人会话生效（机器人管理页可重启实例）。",
        });
      } else {
        setMessage({ kind: "error", text: payload.error ?? "保存失败" });
      }
    } finally {
      setSaving(false);
    }
  };

  const test = async (): Promise<void> => {
    setTesting(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/session-storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "test",
          backend,
          d1: {
            account_id: d1.account_id,
            database_id: d1.database_id,
            ...(d1.api_token.trim() ? { api_token: d1.api_token } : {}),
          },
          r2: {
            account_id: r2.account_id,
            access_key_id: r2.access_key_id,
            ...(r2.secret_access_key.trim() ? { secret_access_key: r2.secret_access_key } : {}),
            bucket: r2.bucket,
            cdn_url: r2.cdn_url,
          },
          s3: {
            endpoint: s3.endpoint,
            region: s3.region,
            bucket: s3.bucket,
            access_key_id: s3.access_key_id,
            ...(s3.secret_access_key.trim() ? { secret_access_key: s3.secret_access_key } : {}),
            path_style: s3.path_style,
            cdn_url: s3.cdn_url,
          },
        }),
      });
      const payload = (await response.json()) as {
        ok: boolean;
        data?: { detail: string; latency_ms: number; public_url?: { url: string; via_cdn: boolean } | null };
      };
      if (payload.data) {
        const cdnNote = payload.data.public_url
          ? `｜公开读取${payload.data.public_url.via_cdn ? "走 CDN：" : "（未配置 CDN，回退源站）："}${payload.data.public_url.url}`
          : "";
        setMessage({
          kind: payload.ok ? "ok" : "error",
          text: `${payload.data.detail}（${payload.data.latency_ms}ms）${payload.ok ? cdnNote : ""}`,
        });
      }
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="rounded-xl border bg-card p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">BOT 数据存储（会话持久化）</h2>
          <p className="text-sm text-muted-foreground">
            grammY session 外部存储：一键切换机器人会话数据的落盘位置。D1/R2 在 Cloudflare Pages（edge）部署时自动探测绑定，
            Node 环境走 REST API。
          </p>
        </div>
        <span className="rounded-full border bg-muted/40 px-3 py-1 text-xs font-medium text-muted-foreground">
          当前：{BACKENDS.find((item) => item.value === backend)?.icon}{" "}
          {BACKENDS.find((item) => item.value === backend)?.label}
        </span>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <label className="flex cursor-pointer items-center justify-between rounded-lg border px-3 py-2.5">
            <span className="text-sm font-medium">启用外部会话存储</span>
            <span className="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full bg-muted transition-colors has-[:checked]:bg-primary">
              <input
                type="checkbox"
                checked={backend !== "memory"}
                onChange={(event) => setBackend(event.target.checked ? "sqlite" : "memory")}
                className="peer sr-only"
              />
              <span className="pointer-events-none absolute left-0.5 h-5 w-5 rounded-full bg-background shadow transition-transform peer-checked:translate-x-5" />
            </span>
          </label>
          {backend !== "memory" ? (
            <div className="space-y-1">
              <label className="block text-sm font-medium" htmlFor="session-backend">存储后端</label>
              <select
                id="session-backend"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={backend}
                onChange={(event) => setBackend(event.target.value)}
              >
                {BACKENDS.filter((item) => item.value !== "memory").map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.icon} {item.label}
                  </option>
                ))}
              </select>
              <p className="text-sm text-muted-foreground">
                每个机器人还可在「机器人管理 → 插件」里单独覆盖（inherit = 跟随此处全局配置）。
              </p>
            </div>
          ) : null}
          {backend === "sqlite" && config ? (
            <p className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              已持久化 {config.sqlite_sessions} 条会话数据。
            </p>
          ) : null}
        </div>

        {backend === "d1" ? (
          <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
            <p className="text-sm font-medium">Cloudflare D1（REST API）</p>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <label className="block text-sm font-medium" htmlFor="d1-account">Account ID</label>
                <input id="d1-account" className={`${inputClass} font-mono`} value={d1.account_id} onChange={(e) => setD1((p) => ({ ...p, account_id: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <label className="block text-sm font-medium" htmlFor="d1-db">Database ID</label>
                <input id="d1-db" className={`${inputClass} font-mono`} value={d1.database_id} onChange={(e) => setD1((p) => ({ ...p, database_id: e.target.value }))} />
              </div>
            </div>
            <div className="space-y-1">
              <label className="block text-sm font-medium" htmlFor="d1-token">API Token {config?.d1.has_api_token ? "（留空保持不变）" : ""}</label>
              <input id="d1-token" type="password" className={`${inputClass} font-mono`} value={d1.api_token} onChange={(e) => setD1((p) => ({ ...p, api_token: e.target.value }))} placeholder={config?.d1.has_api_token ? config.d1.api_token_masked : "需要 D1 读写权限"} />
            </div>
            <p className="text-xs text-muted-foreground">首次连接自动建表 bot_sessions (scope, session_key, value)。</p>
          </div>
        ) : null}

        {backend === "r2" ? (
          <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
            <p className="text-sm font-medium">Cloudflare R2（S3 兼容 API + SigV4）</p>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <label className="block text-sm font-medium" htmlFor="r2-account">Account ID</label>
                <input id="r2-account" className={`${inputClass} font-mono`} value={r2.account_id} onChange={(e) => setR2((p) => ({ ...p, account_id: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <label className="block text-sm font-medium" htmlFor="r2-bucket">Bucket</label>
                <input id="r2-bucket" className={`${inputClass} font-mono`} value={r2.bucket} onChange={(e) => setR2((p) => ({ ...p, bucket: e.target.value }))} />
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <label className="block text-sm font-medium" htmlFor="r2-ak">Access Key ID</label>
                <input id="r2-ak" className={`${inputClass} font-mono`} value={r2.access_key_id} onChange={(e) => setR2((p) => ({ ...p, access_key_id: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <label className="block text-sm font-medium" htmlFor="r2-sk">Secret Access Key {config?.r2.has_secret ? "（留空保持不变）" : ""}</label>
                <input id="r2-sk" type="password" className={`${inputClass} font-mono`} value={r2.secret_access_key} onChange={(e) => setR2((p) => ({ ...p, secret_access_key: e.target.value }))} placeholder={config?.r2.has_secret ? config.r2.secret_masked : ""} />
              </div>
            </div>
            <div className="space-y-1">
              <label className="block text-sm font-medium" htmlFor="r2-cdn">CDN 加速域名（可选，自定义域名）</label>
              <input id="r2-cdn" className={`${inputClass} font-mono`} placeholder="https://cdn.example.com（R2 存储桶 → 设置 → 公开访问 → 自定义域）" value={r2.cdn_url} onChange={(e) => setR2((p) => ({ ...p, cdn_url: e.target.value }))} />
              <p className="text-xs text-muted-foreground">
                配置后对象公开读取 URL 走自定义 CDN 域名（如 https://cdn.example.com/&lt;key&gt;），可套 Cloudflare 缓存加速；留空回退源站 S3 API 域名。
              </p>
            </div>
          </div>
        ) : null}

        {backend === "s3" ? (
          <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
            <p className="text-sm font-medium">S3 兼容对象存储（AWS SigV4）</p>
            <div className="space-y-1">
              <label className="block text-sm font-medium" htmlFor="s3-endpoint">Endpoint</label>
              <input id="s3-endpoint" className={`${inputClass} font-mono`} placeholder="https://s3.us-east-1.amazonaws.com 或 https://minio.example.com" value={s3.endpoint} onChange={(e) => setS3((p) => ({ ...p, endpoint: e.target.value }))} />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <label className="block text-sm font-medium" htmlFor="s3-region">Region</label>
                <input id="s3-region" className={`${inputClass} font-mono`} placeholder="us-east-1" value={s3.region} onChange={(e) => setS3((p) => ({ ...p, region: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <label className="block text-sm font-medium" htmlFor="s3-bucket">Bucket</label>
                <input id="s3-bucket" className={`${inputClass} font-mono`} value={s3.bucket} onChange={(e) => setS3((p) => ({ ...p, bucket: e.target.value }))} />
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <label className="block text-sm font-medium" htmlFor="s3-ak">Access Key ID</label>
                <input id="s3-ak" className={`${inputClass} font-mono`} value={s3.access_key_id} onChange={(e) => setS3((p) => ({ ...p, access_key_id: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <label className="block text-sm font-medium" htmlFor="s3-sk">Secret Access Key {config?.s3.has_secret ? "（留空保持不变）" : ""}</label>
                <input id="s3-sk" type="password" className={`${inputClass} font-mono`} value={s3.secret_access_key} onChange={(e) => setS3((p) => ({ ...p, secret_access_key: e.target.value }))} placeholder={config?.s3.has_secret ? config.s3.secret_masked : ""} />
              </div>
            </div>
            <div className="space-y-1">
              <label className="block text-sm font-medium" htmlFor="s3-path-style">寻址风格</label>
              <select
                id="s3-path-style"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={s3.path_style}
                onChange={(e) => setS3((p) => ({ ...p, path_style: e.target.value }))}
              >
                <option value="path">Path-style（endpoint/bucket/key，MinIO/自托管推荐）</option>
                <option value="virtual_hosted">Virtual-hosted（bucket.endpoint/key，AWS 推荐）</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="block text-sm font-medium" htmlFor="s3-cdn">CDN 加速域名（可选，自定义域名）</label>
              <input id="s3-cdn" className={`${inputClass} font-mono`} placeholder="https://dxxxxxxxx.cloudfront.net 或 https://cdn.example.com" value={s3.cdn_url} onChange={(e) => setS3((p) => ({ ...p, cdn_url: e.target.value }))} />
              <p className="text-xs text-muted-foreground">
                配置后对象公开读取 URL 走自定义 CDN 域名（如 AWS CloudFront、Cloudflare 前置）；留空回退源站 endpoint。
              </p>
            </div>
            <p className="text-xs text-muted-foreground">兼容 AWS S3、MinIO、Wasabi、Backblaze B2 等任何支持 SigV4 的 S3 API；会话对象写入 sessions/&lt;key&gt;.json。</p>
          </div>
        ) : null}
      </div>

      {message ? (
        <div
          className={`mt-4 rounded-md border px-4 py-3 text-sm ${
            message.kind === "ok" ? "border-green-200 bg-green-50 text-green-700" : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {message.text}
        </div>
      ) : null}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={test}
          disabled={testing}
          className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent disabled:opacity-50"
        >
          {testing ? "测试中…" : "测试连接"}
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex h-9 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? "保存中…" : "保存存储配置"}
        </button>
      </div>
    </div>
  );
}
