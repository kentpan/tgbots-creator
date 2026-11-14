"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, Loader2, Lock, Pencil, Plus, Trash2 } from "lucide-react";
import { motion } from "framer-motion";
import { Switch } from "@/components/ui/switch";
import { IOS_BLUE, IOS_GRAY_BG, IOS_TEXT_SECONDARY } from "@/components/admin/tg-app-simulator-primitives";

/**
 * 代理偏好设置面板（v2.0.15，机器人测试页仿真屏盾牌按钮 → 右侧区域向左滑入）。
 *
 * 复刻 Telegram Desktop「代理偏好设置」页（截图3）：
 * - 「代理」总开关（关闭 = 直连 api.telegram.org）
 * - 「用于通话」开关（APP 样式还原，v2.0.16 起默认关闭；仅持久化偏好）
 * - 「添加代理」：一键添加「线上 Edge 站代理」（本项目线上部署作为代理源站，
 *   node 开发环境的全部 api.telegram.org 请求经它转发）或自定义 URL 前缀代理
 * - 代理条目：✓ 选中即生效（写入 telegram.proxy_url 并立即失效传输层缓存）、
 *   ⓘ 连通性测试（真实探测，展示「已连接（ping: X 毫秒）」）、✎ 编辑（v2.0.16）、
 *   🗑 删除
 *
 * v2.0.16 编辑面板：点击条目 ✎ 编辑图标 → 向左滑入代理编辑面板；
 * - 自定义前缀代理：名称/地址可改，保存后若该条目正生效则同步更新生效地址；
 * - 线上源站代理（type=edge）：专属「线上源站」标志，只读展示（不可修改删除，
 *   由系统自动生成含专属 Basic 凭据），可正常切换生效与连通性测试。
 *
 * 数据源：/api/admin/telegram/proxy-config（同源 = 当前运行时数据库）；
 * 「线上 Edge 站代理」地址经 fetchEdgeProxyUrl 到线上站点自动生成（含自动生成的 Basic 凭据）。
 */


interface ProxyEntry {
  id: string;
  label: string;
  url: string;
  type: "edge" | "prefix";
  created_at: string;
}

interface ProxyConfig {
  runtime: "node" | "edge";
  enabled: boolean;
  for_calls: boolean;
  active_url: string;
  entries: ProxyEntry[];
  edge_base_url: string;
}

interface PingResult {
  ok: boolean;
  ms?: number;
  error?: string;
}

/** 安全解析响应 JSON */
async function readJson<T>(response: Response): Promise<T | null> {
  try {
    const text = await response.text();
    if (!text.trim()) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * v2.1.0 获取线上 Edge 站代理地址（仅此接口仍需转发线上执行）：
 *
 * 与其他实操不同，本接口的 Basic 凭据必须落在线上站点数据库（tg-proxy 路由在
 * 线上校验凭据），因此 node 环境 + 已配置线上站点（api.base_url，https）时仍把
 * 该请求跨站转发到线上执行；线上未登录/版本落后（无该路由）/不可达时回退同源
 * 本地生成 —— 回退生成的地址域名依然取 api.base_url（v2.1.0 edge-url 修复），
 * 凭据为本地的，待线上部署新版本后重新点一次「一键添加」即可对上线上凭据。
 */
async function fetchEdgeProxyUrl(): Promise<Response> {
  try {
    const info = await fetch("/api/admin/runtime-info", { cache: "no-store" });
    const payload = (await info.json()) as {
      ok?: boolean;
      runtime?: string;
      remote_base_url?: string | null;
    };
    const remote = payload.remote_base_url;
    if (payload.runtime === "node" && typeof remote === "string" && /^https:\/\//i.test(remote)) {
      const response = await fetch(remote.replace(/\/$/, "") + "/api/admin/telegram/proxy-config/edge-url", {
        credentials: "include",
        headers: { "X-Admin-Client": "web" },
        cache: "no-store",
      });
      if (response.ok) return response;
      console.warn(`[proxy-panel] 线上站点 edge-url 返回 HTTP ${response.status}，回退本地生成`);
    }
  } catch (error) {
    console.warn(
      "[proxy-panel] 线上站点不可达，回退本地生成:",
      error instanceof Error ? error.message : String(error),
    );
  }
  return fetch("/api/admin/telegram/proxy-config/edge-url", { cache: "no-store" });
}

/** 编辑面板滑入动画（向左滑入 = 从右侧进入，与外层面板同款） */
const EDIT_PANEL_VARIANTS = {
  enter: { x: "100%" },
  center: { x: "0%" },
  exit: { x: "100%" },
};

export function TgProxyPanel({
  onClose,
  onNotify,
}: {
  onClose: () => void;
  onNotify: (ok: boolean, text: string) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState<ProxyConfig | null>(null);
  const [pings, setPings] = useState<Record<string, PingResult | "testing">>({});
  // 添加代理表单：mode=null 收起；edge=一键添加线上 Edge 站代理；prefix=自定义 URL
  const [addMode, setAddMode] = useState<"edge" | "prefix" | null>(null);
  const [customUrl, setCustomUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [edgeHint, setEdgeHint] = useState<string | null>(null);
  // v2.0.16 编辑面板：editingId=null 收起；非空=正在编辑该条目（线上源站只读）
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editHint, setEditHint] = useState<string | null>(null);

  const loadConfig = useCallback(async (): Promise<ProxyConfig | null> => {
    const response = await fetch("/api/admin/telegram/proxy-config", { cache: "no-store" });
    const payload = await readJson<{ ok: boolean; error?: string; data?: ProxyConfig }>(response);
    if (!payload) {
      onNotify(false, `服务返回异常（HTTP ${response.status}），请查看服务端日志后重试`);
      return null;
    }
    if (!payload.ok || !payload.data) {
      onNotify(false, payload.error ?? "读取代理配置失败");
      return null;
    }
    setConfig(payload.data);
    return payload.data;
  }, [onNotify]);

  useEffect(() => {
    void (async () => {
      await loadConfig();
      setLoading(false);
    })();

  }, []);

  const save = useCallback(
    async (patch: Partial<Pick<ProxyConfig, "enabled" | "for_calls" | "active_url" | "entries">>): Promise<boolean> => {
      if (saving) return false;
      setSaving(true);
      try {
        const response = await fetch("/api/admin/telegram/proxy-config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        const payload = await readJson<{ ok: boolean; error?: string }>(response);
        if (!payload || !payload.ok) {
          onNotify(false, payload?.error ?? "保存失败");
          return false;
        }
        return true;
      } catch (error) {
        onNotify(false, error instanceof Error ? error.message : "保存失败");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [saving, onNotify],
  );

  const refresh = useCallback(async (): Promise<void> => {
    await loadConfig();
  }, [loadConfig]);

  /** ⓘ 连通性测试：真实探测代理链路（HTTP 有响应 = 连通，耗时即 ping） */
  const testEntry = useCallback(
    async (entry: ProxyEntry): Promise<void> => {
      if (pings[entry.id] === "testing") return;
      setPings((prev) => ({ ...prev, [entry.id]: "testing" }));
      try {
        const response = await fetch("/api/admin/telegram/proxy-config/ping", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: entry.url }),
        });
        const payload = await readJson<{ ok: boolean; error?: string; data?: PingResult }>(response);
        const data = payload?.ok ? payload.data ?? null : null;
        setPings((prev) => ({
          ...prev,
          [entry.id]: data
            ? { ok: !data.error, ms: data.ms, error: data.error }
            : { ok: false, error: payload?.error ?? "探测失败" },
        }));
      } catch (error) {
        setPings((prev) => ({
          ...prev,
          [entry.id]: { ok: false, error: error instanceof Error ? error.message : "探测失败" },
        }));
      }
    },
    [pings],
  );

  /** 添加代理：edge=经 fetchEdgeProxyUrl 到线上站点取自动生成的代理地址；prefix=自定义 */
  const addProxy = useCallback(async (): Promise<void> => {
    if (adding) return;
    setAdding(true);
    setEdgeHint(null);
    try {
      let url = "";
      let type: "edge" | "prefix" = "prefix";
      if (addMode === "edge") {
        // v2.1.0：经 fetchEdgeProxyUrl 转发线上生成凭据（线上可达时），回退本地生成；
        // 地址域名一律取系统设置 api.base_url（线上站点）
        const response = await fetchEdgeProxyUrl();
        const payload = await readJson<{ ok: boolean; error?: string; data?: { proxy_url: string } }>(response);
        if (!payload) {
          setEdgeHint(`服务返回异常（HTTP ${response.status}）`);
          return;
        }
        if (!payload.ok || !payload.data) {
          setEdgeHint(payload.error ?? "获取线上 Edge 站代理地址失败");
          return;
        }
        url = payload.data.proxy_url;
        type = "edge";
      } else {
        url = customUrl.trim();
        if (!/^https?:\/\/\S+$/i.test(url)) {
          setEdgeHint("代理地址不合法（需 http/https 开头，如 https://user:pass@host/prefix）");
          return;
        }
      }
      const current = config;
      if (!current) return;
      if (current.entries.some((entry) => entry.url === url)) {
        setEdgeHint("该代理地址已存在");
        return;
      }
      // v2.1.0：线上源站条目全局唯一 —— 已存在 edge 条目时更新其地址（纠正历史
      // 域名/重新生成凭据），不再新增第二条（edge 条目不可手动删除，避免僵尸条目）
      const existingEdge = current.entries.find((entry) => entry.type === "edge");
      if (type === "edge" && existingEdge) {
        const entries = current.entries.map((entry) =>
          entry.id === existingEdge.id ? { ...entry, url, label: "" } : entry,
        );
        if (
          await save({
            entries,
            active_url: url, // 重新生成后默认选中生效
          })
        ) {
          setAddMode(null);
          await refresh();
          onNotify(true, "线上 Edge 站代理已更新并启用：地址按系统设置中的线上站点（api.base_url）重新生成");
        }
        return;
      }
      const entry: ProxyEntry = {
        id: `p${Date.now()}${Math.floor(Math.random() * 1000)}`,
        label: "",
        url,
        type,
        created_at: new Date().toISOString(),
      };
      const entries = [...current.entries, entry];
      if (
        await save({
          entries,
          active_url: url, // 新添加的代理默认选中生效（与 APP 添加后自动启用一致）
        })
      ) {
        setAddMode(null);
        setCustomUrl("");
        await refresh();
        onNotify(true, type === "edge" ? "线上 Edge 站代理已添加并启用：本地 Telegram 请求将经线上站点转发" : "代理已添加并启用");
      }
    } finally {
      setAdding(false);
    }
  }, [adding, addMode, customUrl, config, save, refresh, onNotify]);

  /** 删除条目：若删的是生效条目则同时清空 active_url（传输层回退内置默认代理） */
  const removeEntry = useCallback(
    async (entry: ProxyEntry): Promise<void> => {
      const current = config;
      if (!current) return;
      // 线上源站代理由系统生成：不可删除
      if (entry.type === "edge") {
        onNotify(false, "线上源站代理不可删除：它由线上站点自动生成并绑定专属凭据");
        return;
      }
      const entries = current.entries.filter((item) => item.id !== entry.id);
      const activeUrl = current.active_url === entry.url ? "" : current.active_url;
      if (await save({ entries, active_url: activeUrl })) {
        if (editingId === entry.id) setEditingId(null);
        await refresh();
        onNotify(true, "代理已删除");
      }
    },
    [config, save, refresh, onNotify, editingId],
  );

  /** 选中条目即生效（线上源站/自定义条目均可正常切换） */
  const selectEntry = useCallback(
    async (entry: ProxyEntry): Promise<void> => {
      const current = config;
      if (!current || current.active_url === entry.url) return;
      if (await save({ active_url: entry.url })) {
        await refresh();
        onNotify(true, "已切换生效代理，下一次 Telegram 请求即走新链路");
      }
    },
    [config, save, refresh, onNotify],
  );

  const toggleEnabled = useCallback(
    async (checked: boolean): Promise<void> => {
      if (await save({ enabled: checked })) {
        await refresh();
        onNotify(
          true,
          checked ? "代理已开启" : "代理已关闭：所有 Telegram 请求直连 api.telegram.org",
        );
      }
    },
    [save, refresh, onNotify],
  );

  const toggleForCalls = useCallback(
    async (checked: boolean): Promise<void> => {
      if (await save({ for_calls: checked })) {
        await refresh();
      }
    },
    [save, refresh],
  );

  /** ✎ 打开编辑面板（线上源站条目进入只读模式） */
  const openEditPanel = useCallback((entry: ProxyEntry): void => {
    setEditingId(entry.id);
    setEditLabel(entry.label);
    setEditUrl(entry.url);
    setEditHint(null);
  }, []);

  const editingEntry = config?.entries.find((entry) => entry.id === editingId) ?? null;
  const editingIsEdge = editingEntry?.type === "edge";

  /** 保存编辑：自定义代理可改名称/地址；生效中的条目地址变更后同步更新 active_url */
  const saveEdit = useCallback(async (): Promise<void> => {
    const current = config;
    if (!current || !editingEntry || editSaving) return;
    if (editingIsEdge) {
      onNotify(false, "线上源站代理不可修改：地址与凭据由线上站点自动生成");
      return;
    }
    const url = editUrl.trim();
    if (!/^https?:\/\/\S+$/i.test(url)) {
      setEditHint("代理地址不合法（需 http/https 开头，如 https://user:pass@host/prefix）");
      return;
    }
    if (current.entries.some((entry) => entry.id !== editingEntry.id && entry.url === url)) {
      setEditHint("该代理地址已存在");
      return;
    }
    setEditSaving(true);
    try {
      const entries = current.entries.map((entry) =>
        entry.id === editingEntry.id
          ? { ...entry, label: editLabel.trim() || url, url }
          : entry,
      );
      const wasActive = current.active_url === editingEntry.url;
      if (await save({ entries, ...(wasActive ? { active_url: url } : {}) })) {
        setEditingId(null);
        await refresh();
        onNotify(true, wasActive ? "代理已更新且保持生效" : "代理已更新");
      }
    } finally {
      setEditSaving(false);
    }
  }, [config, editingEntry, editingIsEdge, editLabel, editUrl, editSaving, save, refresh, onNotify]);

  return (
    <div className="relative flex h-full flex-col" style={{ backgroundColor: IOS_GRAY_BG }}>
      {/* 顶部：返回 + 标题（复刻图3） */}
      <div className="flex items-center border-b border-black/[0.06] bg-white/85 px-3 py-2 backdrop-blur">
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭代理偏好设置"
          className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-black/[0.06] text-black transition-transform active:scale-95"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <span className="flex-1 text-center text-[17px] font-semibold text-black">代理偏好设置</span>
        <span className="h-9 w-9" aria-hidden />
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {loading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-6 w-6 animate-spin text-[#8e8e93]" />
          </div>
        ) : (
          <>
            {/* 卡片1：代理总开关 + 用于通话 */}
            <div className="overflow-hidden rounded-xl bg-white">
              <div className="flex items-center justify-between px-4 py-3">
                <span className="text-[17px] text-black">代理</span>
                <Switch
                  checked={config?.enabled ?? false}
                  onCheckedChange={(checked) => void toggleEnabled(checked)}
                  className="data-[state=checked]:bg-[#3390ec]"
                  aria-label="代理开关"
                />
              </div>
              <div className="border-t border-black/[0.06] px-4 py-2 text-[12px] leading-relaxed" style={{ color: IOS_TEXT_SECONDARY }}>
                {config?.enabled
                  ? "已开启：所有 api.telegram.org 请求走下方选中的代理（未选中条目时使用内置默认代理）"
                  : "已关闭（直连 api.telegram.org）"}
                {config?.runtime === "node" ? " · 当前为 node 开发环境" : " · 当前为线上 edge 环境（直连优先，代理作回退通道）"}
              </div>
              <div className="flex items-center justify-between border-t border-black/[0.06] px-4 py-3">
                <span className="text-[17px] text-black">用于通话</span>
                <Switch
                  checked={config?.for_calls ?? false}
                  onCheckedChange={(checked) => void toggleForCalls(checked)}
                  className="data-[state=checked]:bg-[#3390ec]"
                  aria-label="用于通话"
                />
              </div>
              <div className="border-t border-black/[0.06] px-4 py-2 text-[12px]" style={{ color: IOS_TEXT_SECONDARY }}>
                APP 样式还原项（默认关闭）：本项目暂无通话功能，开关仅保存偏好
              </div>
            </div>

            {/* 卡片2：添加代理 + 条目列表 */}
            <div className="overflow-hidden rounded-xl bg-white">
              <button
                type="button"
                onClick={() => setAddMode((prev) => (prev ? null : "edge"))}
                className="flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-black/[0.03]"
                aria-expanded={addMode !== null}
              >
                <Plus className="h-5 w-5" style={{ color: IOS_BLUE }} />
                <span className="text-[17px]" style={{ color: IOS_BLUE }}>
                  添加代理
                </span>
              </button>

              {/* 添加表单：一键 Edge 站代理 / 自定义前缀代理 */}
              {addMode !== null ? (
                <div className="space-y-3 border-t border-black/[0.06] bg-black/[0.02] px-4 py-3">
                  <div className="flex rounded-lg bg-black/[0.05] p-0.5">
                    {(
                      [
                        { value: "edge", label: "线上 Edge 站代理（推荐）" },
                        { value: "prefix", label: "自定义前缀代理" },
                      ] as const
                    ).map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setAddMode(option.value)}
                        className={`flex-1 rounded-[7px] py-1.5 text-[13px] font-medium transition-all ${
                          addMode === option.value ? "bg-white text-black shadow-sm" : "text-[#8e8e93]"
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>

                  {addMode === "edge" ? (
                    <p className="text-[12.5px] leading-relaxed" style={{ color: IOS_TEXT_SECONDARY }}>
                      将本项目线上部署的 Edge 站作为代理源站：地址由线上站点自动生成（含专属 Basic 凭据，
                      防开放代理滥用）。添加后，本机所有 api.telegram.org 请求经线上站点转发。
                      {config && !config.edge_base_url ? " 未检测到线上站点地址（api.base_url），请先在系统设置中配置。" : ""}
                    </p>
                  ) : (
                    <div className="space-y-1.5">
                      <input
                        value={customUrl}
                        onChange={(event) => setCustomUrl(event.target.value)}
                        placeholder="https://user:pass@proxy-host/prefix"
                        aria-label="自定义代理地址"
                        className="w-full rounded-lg bg-black/[0.04] px-3 py-2 font-mono text-[13px] text-black outline-none"
                      />
                      <p className="text-[12px]" style={{ color: IOS_TEXT_SECONDARY }}>
                        URL 前缀式代理：最终请求为 &lt;前缀&gt;/https://api.telegram.org/…，userinfo 会自动转为 Basic 鉴权头
                      </p>
                    </div>
                  )}

                  {edgeHint ? <p className="text-[12.5px] text-red-600">{edgeHint}</p> : null}

                  <button
                    type="button"
                    onClick={() => void addProxy()}
                    disabled={adding}
                    className="w-full cursor-pointer rounded-full py-2.5 text-[15px] font-semibold text-white transition-transform active:scale-[0.99] disabled:opacity-60"
                    style={{ backgroundColor: IOS_BLUE }}
                  >
                    {adding ? (
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        正在获取/添加…
                      </span>
                    ) : addMode === "edge" ? (
                      "一键添加线上 Edge 站代理"
                    ) : (
                      "添加代理"
                    )}
                  </button>
                </div>
              ) : null}

              {/* 代理条目列表（✓ 选中生效 / ⓘ 测试 / ✎ 编辑 / 🗑 删除，复刻图3） */}
              {(config?.entries ?? []).length === 0 ? (
                <div className="border-t border-black/[0.06] px-4 py-4 text-[14px]" style={{ color: IOS_TEXT_SECONDARY }}>
                  暂无代理条目：推荐「添加代理 → 线上 Edge 站代理」一键接入
                </div>
              ) : (
                config?.entries.map((entry) => {
                  const isActive = config.active_url === entry.url;
                  const ping = pings[entry.id];
                  const isEdge = entry.type === "edge";
                  return (
                    <div key={entry.id} className="border-t border-black/[0.06]">
                      <div className="flex items-center gap-3 px-4 py-3">
                        <button
                          type="button"
                          onClick={() => void selectEntry(entry)}
                          aria-label={isActive ? "当前生效代理" : "选中该代理"}
                          className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center"
                        >
                          {isActive ? (
                            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke={IOS_BLUE} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <path d="M4 12.5l5 5L20 6.5" />
                            </svg>
                          ) : (
                            <span className="block h-5 w-5 rounded-full border-2 border-black/10" aria-hidden />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => void selectEntry(entry)}
                          className="min-w-0 flex-1 cursor-pointer text-left"
                        >
                          <p className="flex min-w-0 items-center gap-1.5 text-[16px] font-medium text-[#5e6e7e]">
                            <span className="min-w-0 truncate">{entry.label || entry.url}</span>
                            {/* v2.0.16 线上源站专属标志（不可修改删除，可切换/测试） */}
                            {isEdge ? (
                              <span
                                className="inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                                style={{ backgroundColor: "rgba(51,144,236,0.12)", color: IOS_BLUE }}
                                title="线上源站代理：由线上站点自动生成（含专属凭据），不可修改删除，可正常切换与测试"
                              >
                                <Lock className="h-2.5 w-2.5" aria-hidden />
                                线上源站
                              </span>
                            ) : null}
                          </p>
                          <p className="mt-0.5 truncate text-[13px]" style={{ color: ping && typeof ping === "object" && !ping.ok ? "#eb5545" : IOS_BLUE }}>
                            {ping === "testing" ? (
                              "正在测试连通性…"
                            ) : ping ? (
                              ping.ok ? (
                                `${isEdge ? "Edge 站代理" : "https 前缀代理"}: 已连接（ping: ${ping.ms ?? "?"} 毫秒）`
                              ) : (
                                `连接失败：${ping.error ?? "未知错误"}`
                              )
                            ) : (
                              `${isEdge ? "Edge 站代理" : "https 前缀代理"}${isActive ? " · 生效中" : ""}`
                            )}
                          </p>
                        </button>
                        <button
                          type="button"
                          onClick={() => void testEntry(entry)}
                          disabled={ping === "testing"}
                          aria-label="测试连通性"
                          className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-[#3390ec] transition-transform active:scale-95 disabled:opacity-60"
                        >
                          {ping === "testing" ? (
                            <Loader2 className="h-5 w-5 animate-spin" />
                          ) : (
                            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                              <circle cx="12" cy="12" r="9.5" />
                              <path d="M12 11v6" strokeLinecap="round" />
                              <circle cx="12" cy="7.5" r="1.2" fill="currentColor" stroke="none" />
                            </svg>
                          )}
                        </button>
                        {/* ✎ 编辑（线上源站条目也可点击 → 只读详情面板） */}
                        <button
                          type="button"
                          onClick={() => openEditPanel(entry)}
                          aria-label="编辑代理"
                          className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-[#3390ec] transition-transform active:scale-95"
                        >
                          <Pencil className="h-[18px] w-[18px]" />
                        </button>
                        {/* 🗑 删除（线上源站代理不可删除：不渲染按钮） */}
                        {!isEdge ? (
                          <button
                            type="button"
                            onClick={() => void removeEntry(entry)}
                            aria-label="删除代理"
                            className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-[#3390ec] transition-transform active:scale-95"
                          >
                            <Trash2 className="h-5 w-5" />
                          </button>
                        ) : (
                          <span className="h-9 w-9 shrink-0" aria-hidden />
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <p className="px-1 text-[12.5px] leading-relaxed" style={{ color: IOS_TEXT_SECONDARY }}>
              生效代理保存于当前运行环境数据库（node=本地 SQLite / 线上=D1），
              保存后立即失效传输层缓存 —— 下一次 Bot API 请求即按新链路执行，无需重启。
              系统设置中的 Telegram 代理配置已迁移至此统一管理。
            </p>
          </>
        )}
      </div>

      {/* v2.0.16 代理编辑面板：点击条目 ✎ 后向左滑入（覆盖本面板内容区） */}
      {editingEntry ? (
        <motion.div
          key="proxy-edit"
          variants={EDIT_PANEL_VARIANTS}
          initial="enter"
          animate="center"
          exit="exit"
          transition={{ type: "tween", duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
          className="absolute inset-0 z-10 flex flex-col"
          style={{ backgroundColor: IOS_GRAY_BG }}
          role="dialog"
          aria-label="编辑代理"
        >
          <div className="flex items-center border-b border-black/[0.06] bg-white/85 px-3 py-2 backdrop-blur">
            <button
              type="button"
              onClick={() => setEditingId(null)}
              aria-label="返回代理列表"
              className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-black/[0.06] text-black transition-transform active:scale-95"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <span className="flex-1 text-center text-[17px] font-semibold text-black">
              {editingIsEdge ? "代理详情" : "编辑代理"}
            </span>
            <span className="h-9 w-9" aria-hidden />
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
            {editingIsEdge ? (
              <>
                {/* 线上源站专属标志 + 只读说明 */}
                <div className="rounded-xl bg-white px-4 py-4">
                  <div className="flex items-center gap-2">
                    <span
                      className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[12px] font-semibold"
                      style={{ backgroundColor: "rgba(51,144,236,0.12)", color: IOS_BLUE }}
                    >
                      <Lock className="h-3 w-3" aria-hidden />
                      线上源站
                    </span>
                    <span className="text-[13px]" style={{ color: IOS_TEXT_SECONDARY }}>
                      Edge 站代理 · 系统托管
                    </span>
                  </div>
                  <p className="mt-3 text-[12.5px] leading-relaxed" style={{ color: IOS_TEXT_SECONDARY }}>
                    该代理由线上 Edge 站（本项目线上部署）自动生成并绑定专属 Basic 凭据，
                    用于防止开放代理被滥用 —— 因此
                    <span className="font-medium text-black">不可修改、不可删除</span>；
                    可正常切换为生效代理，也可随时测试连通性。
                  </p>
                </div>
                <div className="overflow-hidden rounded-xl bg-white">
                  <div className="border-b border-black/[0.06] px-4 py-2.5">
                    <p className="text-[13px]" style={{ color: IOS_TEXT_SECONDARY }}>名称（只读）</p>
                    <p className="mt-1 break-all text-[15px] text-black">{editingEntry.label || editingEntry.url}</p>
                  </div>
                  <div className="px-4 py-2.5">
                    <p className="text-[13px]" style={{ color: IOS_TEXT_SECONDARY }}>地址（只读）</p>
                    <p className="mt-1 break-all font-mono text-[13px] text-black">{editingEntry.url}</p>
                  </div>
                </div>
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={() => void testEntry(editingEntry)}
                    disabled={pings[editingEntry.id] === "testing"}
                    className="w-full cursor-pointer rounded-full py-3 text-[16px] font-semibold text-white transition-transform active:scale-[0.99] disabled:opacity-60"
                    style={{ backgroundColor: IOS_BLUE }}
                  >
                    {pings[editingEntry.id] === "testing" ? (
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        正在测试连通性…
                      </span>
                    ) : (
                      "测试连通性"
                    )}
                  </button>
                  {config && config.active_url !== editingEntry.url ? (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(null);
                        void selectEntry(editingEntry);
                      }}
                      className="w-full cursor-pointer rounded-full border border-black/10 bg-white py-3 text-[16px] font-semibold text-black transition-transform active:scale-[0.99]"
                    >
                      设为生效代理
                    </button>
                  ) : null}
                  {(() => {
                    const ping = pings[editingEntry.id];
                    if (!ping || ping === "testing") return null;
                    return (
                      <p className={`text-center text-[12.5px] ${ping.ok ? "text-[#1e8e3e]" : "text-red-600"}`}>
                        {ping.ok ? `已连接（ping: ${ping.ms ?? "?"} 毫秒）` : `连接失败：${ping.error ?? "未知错误"}`}
                      </p>
                    );
                  })()}
                </div>
              </>
            ) : (
              <>
                {/* 自定义代理：名称/地址可编辑 */}
                <div className="overflow-hidden rounded-xl bg-white">
                  <div className="border-b border-black/[0.06] px-4 py-2.5">
                    <label htmlFor="proxy-edit-label" className="text-[13px]" style={{ color: IOS_TEXT_SECONDARY }}>
                      名称
                    </label>
                    <input
                      id="proxy-edit-label"
                      value={editLabel}
                      onChange={(event) => setEditLabel(event.target.value)}
                      placeholder="如：自建代理 / kent 网关"
                      className="mt-1 w-full bg-transparent text-[15px] text-black outline-none"
                    />
                  </div>
                  <div className="px-4 py-2.5">
                    <label htmlFor="proxy-edit-url" className="text-[13px]" style={{ color: IOS_TEXT_SECONDARY }}>
                      地址
                    </label>
                    <textarea
                      id="proxy-edit-url"
                      value={editUrl}
                      onChange={(event) => setEditUrl(event.target.value)}
                      rows={3}
                      className="mt-1 w-full resize-none rounded-lg bg-black/[0.04] px-3 py-2 font-mono text-[13px] leading-relaxed text-black outline-none"
                    />
                    <p className="mt-1 text-[12px]" style={{ color: IOS_TEXT_SECONDARY }}>
                      URL 前缀式代理：userinfo（user:pass@）自动转为 Basic 鉴权头
                    </p>
                  </div>
                </div>

                {editHint ? <p className="px-1 text-[12.5px] text-red-600">{editHint}</p> : null}

                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={() => void saveEdit()}
                    disabled={editSaving}
                    className="w-full cursor-pointer rounded-full py-3 text-[16px] font-semibold text-white transition-transform active:scale-[0.99] disabled:opacity-60"
                    style={{ backgroundColor: IOS_BLUE }}
                  >
                    {editSaving ? (
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        正在保存…
                      </span>
                    ) : (
                      "保存"
                    )}
                  </button>
                  {config && config.active_url !== editingEntry.url ? (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(null);
                        void selectEntry(editingEntry);
                      }}
                      className="w-full cursor-pointer rounded-full border border-black/10 bg-white py-3 text-[16px] font-semibold text-black transition-transform active:scale-[0.99]"
                    >
                      设为生效代理
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(null);
                      void removeEntry(editingEntry);
                    }}
                    className="w-full cursor-pointer rounded-full py-3 text-[16px] font-semibold text-red-600 transition-transform active:scale-[0.99]"
                  >
                    删除代理
                  </button>
                </div>
              </>
            )}
          </div>
        </motion.div>
      ) : null}
    </div>
  );
}
