"use client";

import { useEffect, useState } from "react";
import { BotDeployBadge, briefDeployDetail } from "@/components/admin/bot-deploy-badge";
import type { BotDeployCheck } from "@/services/bot-deploy";

/**
 * 机器人列表部署状态单元格（v2.2.1 CSR）：
 * SSR 页面不做网络探测 —— 本组件挂载后经 /api/admin/bot-deploy-status
 * 异步探测真实部署状态（webhook=Telegram getWebhookInfo / polling=本进程权威值），
 * 探测期间展示「探测中…」骨架；机器人管理页列表使用（TGAPI 页为整页批量版）。
 */
export function DeployStatusCell({ botId }: { botId: string }) {
  const [check, setCheck] = useState<BotDeployCheck | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/admin/bot-deploy-status?ids=${botId}`);
        const payload = (await response.json()) as {
          ok: boolean;
          checks?: Record<string, BotDeployCheck>;
          error?: string;
        };
        if (cancelled) return;
        if (!payload.ok || !payload.checks) {
          setError(payload.error ?? `探测接口异常（HTTP ${response.status}）`);
          return;
        }
        setCheck(payload.checks[botId] ?? { key: "unknown", detail: "探测结果缺失" });
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [botId]);

  return (
    <div className="max-w-56 space-y-1">
      {check ? (
        <BotDeployBadge check={check} />
      ) : (
        <span
          className="inline-flex animate-pulse rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-sm text-gray-500"
          title={error ?? "正在探测真实部署状态（Telegram getWebhookInfo）"}
        >
          {error ? "状态未知" : "探测中…"}
        </span>
      )}
      {check && "detail" in check && check.detail ? (
        <p className="text-xs leading-snug text-muted-foreground">{briefDeployDetail(check.detail)}</p>
      ) : null}
      {error && !check ? <p className="text-xs leading-snug text-red-600">{error}</p> : null}
    </div>
  );
}
