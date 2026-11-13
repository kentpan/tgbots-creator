"use client";

import { useEffect, useState } from "react";
import { inputClass, labelClass } from "@/components/admin/form-styles";

interface TgapiProxyConfig {
  enabled: boolean;
  proxyUrl: string;
  authType: "bearer" | "basic";
  bearerKey: string;
  basicUser: string;
  basicPass: string;
}

const EMPTY: TgapiProxyConfig = {
  enabled: false,
  proxyUrl: "",
  authType: "bearer",
  bearerKey: "",
  basicUser: "",
  basicPass: "",
};

/**
 * TGAPI代理配置(可折叠面板) —— 将 my.telegram.org 申请四步调用经 tgapi-proxy-toolkit
 * 代理转发。全局配置(app_settings), 可嵌入申请弹窗/菜单配置/键盘弹窗配置等多处入口。
 * 鉴权: Bearer APIKEY 或 Basic user:pass(与代理端 APIKEYS / CF_PROXY_USERS 共用)。
 */
export function TgapiProxyConfigSection({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [cfg, setCfg] = useState<TgapiProxyConfig>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/tgapi/proxy", { headers: { "Content-Type": "application/json" } })
      .then((r) => r.json())
      .then((d) => { if (d.ok && d.data?.config) setCfg({ ...EMPTY, ...d.data.config }); })
      .catch((e) => console.error("加载TGAPI代理配置失败:", e));
  }, []);

  async function save(): Promise<void> {
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/tgapi/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cfg),
      });
      const d = (await res.json().catch(() => null)) as { ok?: boolean; message?: string; error?: string } | null;
      if (d?.ok) { setMsg(d.message ?? "已保存"); }
      else { setMsg(d?.error ?? `保存失败(HTTP ${res.status})`); }
    } catch (e) {
      setMsg("保存失败: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-md border border-slate-200 bg-slate-50">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium text-slate-700"
      >
        <span>TGAPI代理 {cfg.enabled ? "(已启用)" : ""}</span>
        <span className="text-xs text-slate-400">{open ? "收起 ▲" : "展开 ▼"}</span>
      </button>
      {open ? (
        <div className="space-y-3 border-t border-slate-200 px-3 py-3">
          <p className="text-xs text-muted-foreground">
            将 my.telegram.org 申请四步调用经 tgapi-proxy-toolkit 代理转发(代理端用其上游 PROXIES 访问 my.telegram.org)。仅需配置代理地址 + 鉴权。
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={cfg.enabled}
              onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })}
            />
            启用 TGAPI代理
          </label>
          <div className="space-y-1">
            <label className={labelClass}>代理地址(tgapi-proxy-toolkit 部署 URL)</label>
            <input
              className={inputClass}
              value={cfg.proxyUrl}
              onChange={(e) => setCfg({ ...cfg, proxyUrl: e.target.value })}
              placeholder="https://your-tgapi-proxy.workers.dev"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1">
            <label className={labelClass}>鉴权方式</label>
            <select
              className={inputClass}
              value={cfg.authType}
              onChange={(e) => setCfg({ ...cfg, authType: e.target.value as "bearer" | "basic" })}
            >
              <option value="bearer">Bearer APIKEY</option>
              <option value="basic">Basic user:pass</option>
            </select>
          </div>
          {cfg.authType === "bearer" ? (
            <div className="space-y-1">
              <label className={labelClass}>APIKEY(代理端 APIKEYS)</label>
              <input
                className={inputClass}
                value={cfg.bearerKey}
                onChange={(e) => setCfg({ ...cfg, bearerKey: e.target.value })}
                placeholder="tgx_..."
                autoComplete="off"
              />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className={labelClass}>用户名</label>
                <input
                  className={inputClass}
                  value={cfg.basicUser}
                  onChange={(e) => setCfg({ ...cfg, basicUser: e.target.value })}
                  placeholder="user"
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1">
                <label className={labelClass}>密码</label>
                <input
                  className={inputClass}
                  type="password"
                  value={cfg.basicPass}
                  onChange={(e) => setCfg({ ...cfg, basicPass: e.target.value })}
                  placeholder="pass"
                  autoComplete="off"
                />
              </div>
            </div>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="inline-flex h-9 items-center rounded-md bg-emerald-600 px-4 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {saving ? "保存中…" : "保存代理配置"}
            </button>
            {msg ? <span className="text-xs text-muted-foreground">{msg}</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
