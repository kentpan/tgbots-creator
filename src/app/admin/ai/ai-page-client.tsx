"use client";

import { useCallback, useEffect, useState } from "react";
import { SelfContainedTabs } from "@/components/admin/self-contained-tabs";
import { AiUsageTab } from "./usage-tab";
import { ProviderDialog, type ProviderDialogValue } from "./provider-dialog";

export interface AiProviderListItem {
  id: string;
  name: string;
  base_url: string;
  api_key_masked: string;
  has_api_key: boolean;
  models: string[];
  selected_model: string;
  rate_limit_enabled: boolean;
  rate_limit_max: number;
  rate_limit_window: number;
  is_default: boolean;
  enabled: boolean;
  remark: string;
  created_time: string;
}

interface ListResponse {
  ok: boolean;
  data?: { rows: AiProviderListItem[]; total: number; page: number; pageSize: number };
  error?: string;
}

const PAGE_SIZE = 10;

/** AI 配置页（自包含 Tab：模型配置 + 调用统计） */
export function AiPageClient() {
  const [rows, setRows] = useState<AiProviderListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderDialogValue | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadList = useCallback(async (targetPage = page, search = keyword) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(targetPage), pageSize: String(PAGE_SIZE) });
      if (search.trim()) params.set("keyword", search.trim());
      const response = await fetch(`/api/admin/ai/providers?${params.toString()}`);
      const payload = (await response.json()) as ListResponse;
      if (payload.ok && payload.data) {
        setRows(payload.data.rows);
        setTotal(payload.data.total);
        setPage(payload.data.page);
      } else {
        setMessage({ kind: "error", text: payload.error ?? "加载失败" });
      }
    } finally {
      setLoading(false);
    }
  }, [page, keyword]);

  useEffect(() => {
    void loadList(1, "");
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const refreshModels = async (item: AiProviderListItem): Promise<void> => {
    setBusyId(item.id);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/ai/providers/${item.id}/fetch-models`, { method: "POST" });
      const payload = (await response.json()) as { ok: boolean; data?: { models: string[] }; error?: string };
      if (payload.ok) {
        setMessage({ kind: "ok", text: `「${item.name}」拉取到 ${payload.data?.models.length ?? 0} 个模型` });
        await loadList();
      } else {
        setMessage({ kind: "error", text: `「${item.name}」拉取失败：${payload.error ?? "未知错误"}` });
      }
    } finally {
      setBusyId(null);
    }
  };

  const testProvider = async (item: AiProviderListItem): Promise<void> => {
    setBusyId(item.id);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/ai/providers/${item.id}/test`, { method: "POST" });
      const payload = (await response.json()) as {
        ok: boolean;
        data?: { model: string; content: string; total_tokens: number; duration_ms: number } | null;
        error?: string;
      };
      if (payload.ok && payload.data) {
        setMessage({
          kind: "ok",
          text: `「${item.name}」测试通过：${payload.data.model} → "${payload.data.content.slice(0, 60)}"（${payload.data.duration_ms}ms / ${payload.data.total_tokens} tokens）`,
        });
      } else {
        setMessage({ kind: "error", text: `「${item.name}」测试失败：${payload.error ?? "未知错误"}` });
      }
    } finally {
      setBusyId(null);
    }
  };

  const setDefault = async (item: AiProviderListItem): Promise<void> => {
    setBusyId(item.id);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/ai/providers/${item.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: item.name,
          base_url: item.base_url,
          api_key: "",
          selected_model: item.selected_model,
          rate_limit_enabled: item.rate_limit_enabled,
          rate_limit_max: item.rate_limit_max,
          rate_limit_window: item.rate_limit_window,
          is_default: true,
          enabled: item.enabled,
          remark: item.remark,
        }),
      });
      const payload = (await response.json()) as { ok: boolean; error?: string };
      if (payload.ok) {
        setMessage({ kind: "ok", text: `「${item.name}」已设为默认 AI 模型` });
        await loadList();
      } else {
        setMessage({ kind: "error", text: payload.error ?? "设置失败" });
      }
    } finally {
      setBusyId(null);
    }
  };

  const removeProvider = async (item: AiProviderListItem): Promise<void> => {
    if (!window.confirm(`确认删除 AI 提供方「${item.name}」？调用统计日志将保留。`)) return;
    setBusyId(item.id);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/ai/providers/${item.id}`, { method: "DELETE" });
      const payload = (await response.json()) as { ok: boolean; error?: string };
      if (payload.ok) {
        setMessage({ kind: "ok", text: `「${item.name}」已删除` });
        await loadList();
      } else {
        setMessage({ kind: "error", text: payload.error ?? "删除失败" });
      }
    } finally {
      setBusyId(null);
    }
  };

  const openCreate = (): void => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (item: AiProviderListItem): void => {
    setEditing({
      id: item.id,
      name: item.name,
      base_url: item.base_url,
      selected_model: item.selected_model,
      rate_limit_enabled: item.rate_limit_enabled,
      rate_limit_max: item.rate_limit_max,
      rate_limit_window: item.rate_limit_window,
      is_default: item.is_default,
      enabled: item.enabled,
      remark: item.remark,
    });
    setDialogOpen(true);
  };

  const providersTab = (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <input
            className="h-9 w-56 rounded-md border border-input bg-background px-3 text-sm"
            placeholder="搜索名称 / Base URL / 备注"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void loadList(1);
            }}
          />
          <button
            type="button"
            onClick={() => void loadList(1)}
            className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium hover:bg-accent"
          >
            搜索
          </button>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          ＋ 新增 AI 提供方
        </button>
      </div>

      {message ? (
        <div
          className={`rounded-md border px-4 py-3 text-sm ${
            message.kind === "ok"
              ? "border-green-200 bg-green-50 text-green-700"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {message.text}
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[860px] text-sm">
          <thead className="bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">名称</th>
              <th className="px-4 py-3 font-medium">Base URL</th>
              <th className="px-4 py-3 font-medium">模型</th>
              <th className="px-4 py-3 font-medium">限速</th>
              <th className="px-4 py-3 font-medium">状态</th>
              <th className="px-4 py-3 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">加载中…</td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                  暂无 AI 提供方，点击右上角「新增 AI 提供方」创建第一个模型配置。
                </td>
              </tr>
            ) : (
              rows.map((item) => (
                <tr key={item.id} className="border-t">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 font-medium">
                      {item.name}
                      {item.is_default ? (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">默认</span>
                      ) : null}
                    </div>
                    {item.remark ? <p className="mt-0.5 text-xs text-muted-foreground">{item.remark}</p> : null}
                  </td>
                  <td className="max-w-52 truncate px-4 py-3 font-mono text-xs" title={item.base_url}>
                    {item.base_url}
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium">{item.selected_model === "auto" ? "⚡ auto（自动选择）" : item.selected_model}</div>
                    <div className="text-xs text-muted-foreground">
                      {item.models.length > 0 ? `已缓存 ${item.models.length} 个模型` : "未拉取模型列表"}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {item.rate_limit_enabled ? (
                      <span className="font-mono">{item.rate_limit_max} 次 / {item.rate_limit_window}s</span>
                    ) : (
                      <span className="text-muted-foreground">未启用</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        item.enabled ? "bg-green-100 text-green-700" : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {item.enabled ? "启用" : "停用"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap justify-end gap-1">
                      <button
                        type="button"
                        disabled={busyId === item.id}
                        onClick={() => void refreshModels(item)}
                        className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
                      >
                        拉取模型
                      </button>
                      <button
                        type="button"
                        disabled={busyId === item.id}
                        onClick={() => void testProvider(item)}
                        className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
                      >
                        测试
                      </button>
                      {!item.is_default ? (
                        <button
                          type="button"
                          disabled={busyId === item.id}
                          onClick={() => void setDefault(item)}
                          className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
                        >
                          设为默认
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => openEdit(item)}
                        className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent"
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        disabled={busyId === item.id}
                        onClick={() => void removeProvider(item)}
                        className="rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                      >
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 ? (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">共 {total} 条 · 第 {page} / {totalPages} 页</p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => void loadList(page - 1)}
              className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50"
            >
              上一页
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => void loadList(page + 1)}
              className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50"
            >
              下一页
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );

  return (
    <>
      <SelfContainedTabs
        ariaLabel="AI 配置"
        items={[
          { key: "providers", label: "🧠 模型配置", content: providersTab },
          { key: "usage", label: "📈 调用统计", content: <AiUsageTab /> },
        ]}
      />
      {dialogOpen ? (
        <ProviderDialog open onOpenChange={setDialogOpen} initial={editing} onSaved={() => void loadList()} />
      ) : null}
    </>
  );
}
