"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { inputClass, labelClass, selectClass } from "@/components/admin/form-styles";

export interface ProviderDialogValue {
  id?: string;
  name: string;
  base_url: string;
  selected_model: string;
  rate_limit_enabled: boolean;
  rate_limit_max: number;
  rate_limit_window: number;
  is_default: boolean;
  enabled: boolean;
  remark: string;
}

export function ProviderDialog({
  open,
  onOpenChange,
  initial,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: ProviderDialogValue | null;
  onSaved: () => void;
}) {
  const isEdit = Boolean(initial?.id);
  const [form, setForm] = useState<ProviderDialogValue>(
    initial ?? {
      name: "",
      base_url: "",
      selected_model: "auto",
      rate_limit_enabled: false,
      rate_limit_max: 60,
      rate_limit_window: 60,
      is_default: false,
      enabled: true,
      remark: "",
    },
  );
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [probeState, setProbeState] = useState<{ status: "idle" | "loading" | "ok" | "error"; message: string }>({
    status: "idle",
    message: "",
  });
  const [saveState, setSaveState] = useState<{ status: "idle" | "loading" | "error"; message: string }>({
    status: "idle",
    message: "",
  });

  const probeModels = async (): Promise<void> => {
    if (!/^https?:\/\//i.test(form.base_url.trim())) {
      setProbeState({ status: "error", message: "请先填写以 http(s):// 开头的 Base URL" });
      return;
    }
    setProbeState({ status: "loading", message: "正在探测模型列表…" });
    try {
      const response = await fetch("/api/admin/ai/providers/0/fetch-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base_url: form.base_url, api_key: apiKey }),
      });
      const payload = (await response.json()) as { ok: boolean; data?: { models: string[] }; error?: string };
      if (payload.ok && payload.data) {
        setModels(payload.data.models);
        setProbeState({ status: "ok", message: `探测成功，获取到 ${payload.data.models.length} 个模型` });
      } else {
        setProbeState({ status: "error", message: payload.error ?? "探测失败" });
      }
    } catch (error) {
      setProbeState({ status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const save = async (): Promise<void> => {
    if (!form.name.trim()) {
      setSaveState({ status: "error", message: "名称不能为空" });
      return;
    }
    if (!/^https?:\/\//i.test(form.base_url.trim())) {
      setSaveState({ status: "error", message: "Base URL 必须以 http:// 或 https:// 开头" });
      return;
    }
    setSaveState({ status: "loading", message: "" });
    try {
      const body = {
        name: form.name,
        base_url: form.base_url,
        // 编辑时 API Key 留空 = 保持原值
        api_key: apiKey,
        selected_model: form.selected_model,
        rate_limit_enabled: form.rate_limit_enabled,
        rate_limit_max: Number(form.rate_limit_max) || 60,
        rate_limit_window: Number(form.rate_limit_window) || 60,
        is_default: form.is_default,
        enabled: form.enabled,
        remark: form.remark,
      };
      const response = await fetch(isEdit ? `/api/admin/ai/providers/${initial?.id}` : "/api/admin/ai/providers", {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as { ok: boolean; error?: string };
      if (!payload.ok) {
        setSaveState({ status: "error", message: payload.error ?? "保存失败" });
        return;
      }
      onSaved();
      onOpenChange(false);
    } catch (error) {
      setSaveState({ status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <DialogTitle>{isEdit ? "编辑 AI 提供方" : "新增 AI 提供方"}</DialogTitle>
          <DialogDescription>
            OpenAI 兼容协议（/v1/chat/completions + /v1/models）。支持 OpenAI / DeepSeek / 通义 / 智谱 / Ollama 等。
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1">
              <label className={labelClass} htmlFor="ai-name">名称 *</label>
              <input
                id="ai-name"
                className={inputClass}
                value={form.name}
                onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                placeholder="例如：DeepSeek 官方"
              />
            </div>
            <div className="space-y-1">
              <label className={labelClass} htmlFor="ai-baseurl">Base URL *</label>
              <input
                id="ai-baseurl"
                className={`${inputClass} font-mono`}
                value={form.base_url}
                onChange={(event) => setForm((prev) => ({ ...prev, base_url: event.target.value }))}
                placeholder="https://api.deepseek.com/v1"
              />
            </div>
          </div>
          <div className="space-y-1">
            <label className={labelClass} htmlFor="ai-key">API Key {isEdit ? "（留空保持不变）" : ""}</label>
            <input
              id="ai-key"
              type="password"
              className={`${inputClass} font-mono`}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={isEdit ? "已保存（输入新值可覆盖）" : "sk-..."}
            />
          </div>

          <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">模型列表</p>
              <button
                type="button"
                onClick={probeModels}
                disabled={probeState.status === "loading"}
                className="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium hover:bg-accent disabled:opacity-50"
              >
                {probeState.status === "loading" ? "探测中…" : "探测模型列表"}
              </button>
            </div>
            {probeState.status !== "idle" ? (
              <p
                className={`text-sm ${
                  probeState.status === "ok"
                    ? "text-green-600"
                    : probeState.status === "error"
                      ? "text-red-600"
                      : "text-muted-foreground"
                }`}
              >
                {probeState.message}
              </p>
            ) : null}
            <div className="space-y-1">
              <label className={labelClass} htmlFor="ai-model">指定模型（第一项 auto = 自动选择）</label>
              <select
                id="ai-model"
                className={selectClass}
                value={form.selected_model}
                onChange={(event) => setForm((prev) => ({ ...prev, selected_model: event.target.value }))}
              >
                <option value="auto">auto · 自动选择（使用探测到的第一个模型）</option>
                {models.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
                {models.length === 0 && form.selected_model !== "auto" ? (
                  <option value={form.selected_model}>{form.selected_model}（已保存）</option>
                ) : null}
              </select>
              <p className="text-sm text-muted-foreground">保存后可在列表页随时重新拉取模型列表。</p>
            </div>
          </div>

          <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
            <label className="flex items-center justify-between">
              <span className="text-sm font-medium">接口限速</span>
              <span className="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full bg-muted transition-colors has-[:checked]:bg-primary">
                <input
                  type="checkbox"
                  checked={form.rate_limit_enabled}
                  onChange={(event) => setForm((prev) => ({ ...prev, rate_limit_enabled: event.target.checked }))}
                  className="peer sr-only"
                />
                <span className="pointer-events-none absolute left-0.5 h-5 w-5 rounded-full bg-background shadow transition-transform peer-checked:translate-x-5" />
              </span>
            </label>
            {form.rate_limit_enabled ? (
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1">
                  <label className={labelClass} htmlFor="ai-rate-max">窗口内最大次数</label>
                  <input
                    id="ai-rate-max"
                    type="number"
                    min={1}
                    className={inputClass}
                    value={form.rate_limit_max}
                    onChange={(event) => setForm((prev) => ({ ...prev, rate_limit_max: Number(event.target.value) }))}
                  />
                </div>
                <div className="space-y-1">
                  <label className={labelClass} htmlFor="ai-rate-window">窗口时长（秒）</label>
                  <input
                    id="ai-rate-window"
                    type="number"
                    min={1}
                    className={inputClass}
                    value={form.rate_limit_window}
                    onChange={(event) => setForm((prev) => ({ ...prev, rate_limit_window: Number(event.target.value) }))}
                  />
                </div>
                <p className="text-sm text-muted-foreground md:col-span-2">
                  滑动窗口限速：例如 60 次 / 60s 表示任意 60 秒内最多 60 次调用，超限快速失败并提示重试等待时间。
                </p>
              </div>
            ) : null}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="flex items-center justify-between rounded-lg border px-3 py-2">
              <span className="text-sm font-medium">设为默认模型</span>
              <span className="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full bg-muted transition-colors has-[:checked]:bg-primary">
                <input
                  type="checkbox"
                  checked={form.is_default}
                  onChange={(event) => setForm((prev) => ({ ...prev, is_default: event.target.checked }))}
                  className="peer sr-only"
                />
                <span className="pointer-events-none absolute left-0.5 h-5 w-5 rounded-full bg-background shadow transition-transform peer-checked:translate-x-5" />
              </span>
            </label>
            <label className="flex items-center justify-between rounded-lg border px-3 py-2">
              <span className="text-sm font-medium">启用</span>
              <span className="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full bg-muted transition-colors has-[:checked]:bg-primary">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(event) => setForm((prev) => ({ ...prev, enabled: event.target.checked }))}
                  className="peer sr-only"
                />
                <span className="pointer-events-none absolute left-0.5 h-5 w-5 rounded-full bg-background shadow transition-transform peer-checked:translate-x-5" />
              </span>
            </label>
          </div>

          <div className="space-y-1">
            <label className={labelClass} htmlFor="ai-remark">备注</label>
            <input
              id="ai-remark"
              className={inputClass}
              value={form.remark}
              onChange={(event) => setForm((prev) => ({ ...prev, remark: event.target.value }))}
              placeholder="例如：生产环境主力模型"
            />
          </div>

          {saveState.status === "error" ? (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{saveState.message}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t px-6 py-4">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent"
          >
            取消
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saveState.status === "loading"}
            className="inline-flex h-9 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saveState.status === "loading" ? "保存中…" : "保存"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
