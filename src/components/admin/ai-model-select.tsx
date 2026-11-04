"use client";

import { useEffect, useMemo, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * AI 模型下拉浮层（可复用）
 *
 * 数据源：GET /api/admin/ai/options
 * - 第一项恒为 auto（自动选择：系统默认 provider 的默认模型）
 * - 其余按 provider 分组列出全部可选模型
 * 值语义："auto" | "<providerId>:<model>" | "<providerId>:auto"
 */

export interface AiModelOption {
  value: string;
  label: string;
  providerId: number;
  providerName: string;
  model: string;
  isDefaultProvider: boolean;
}

export function AiModelSelect({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [options, setOptions] = useState<AiModelOption[]>([]);
  const [defaultProviderId, setDefaultProviderId] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  const load = async (): Promise<void> => {
    setLoading(true);
    setLoadError("");
    try {
      const response = await fetch("/api/admin/ai/options");
      const payload = (await response.json()) as {
        ok: boolean;
        data?: { options: AiModelOption[]; default_provider_id: number | null };
        error?: string;
      };
      if (payload.ok && payload.data) {
        setOptions(payload.data.options);
        setDefaultProviderId(payload.data.default_provider_id);
      } else {
        setLoadError(payload.error ?? "加载模型列表失败");
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void load();
  }, [open]);

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return options;
    return options.filter((option) => option.label.toLowerCase().includes(keyword));
  }, [options, search]);

  const current = options.find((option) => option.value === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 text-sm shadow-sm outline-none transition hover:bg-accent/40 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50"
      >
        <span className="truncate text-left">{current ? current.label : value === "auto" ? "⚡ auto · 自动选择（默认模型）" : "选择 AI 模型"}</span>
        <span className="ml-2 text-xs text-muted-foreground">▾</span>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <div className="border-b p-2">
          <input
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            placeholder="搜索模型 / 提供方…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div className="max-h-64 overflow-y-auto p-1">
          {loading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">加载中…</p>
          ) : loadError ? (
            <div className="space-y-2 p-3 text-center">
              <p className="text-sm text-red-600">{loadError}</p>
              <button
                type="button"
                onClick={() => void load()}
                className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-accent"
              >
                重试
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              未找到可选模型。请先到「AI 配置」添加提供方并拉取模型列表。
            </p>
          ) : (
            filtered.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent ${
                  option.value === value ? "bg-accent/60 font-medium" : ""
                }`}
              >
                <span className="truncate">{option.label}</span>
                {option.value === "auto" && defaultProviderId ? (
                  <span className="ml-2 shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                    默认
                  </span>
                ) : null}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
