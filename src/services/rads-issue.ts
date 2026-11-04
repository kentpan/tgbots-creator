import type { CodeApiConfig } from "./external-verify";

export interface RadsIssueOptions {
  title?: string;
  price?: number;
  scriptId?: number;
  maxUses?: number;
}

export interface RadsIssueResult {
  ok: boolean;
  message: string;
  key?: string;
  shareUrl?: string;
  title?: string;
  price?: number;
  maxUses?: number;
  expiresAt?: number | null;
}

interface RadsIssuePayload {
  ok?: boolean;
  error?: string;
  data?: {
    key?: string;
    url?: string;
    title?: string;
    price?: number;
    max_uses?: number;
    expires_at?: number | null;
  };
}

export function hasRadsIssueConfig(config: CodeApiConfig): boolean {
  return Boolean(config.rads_base_url && config.rads_issue_key);
}

export async function issueRadsCard(
  config: CodeApiConfig,
  options: RadsIssueOptions = {},
): Promise<RadsIssueResult> {
  if (!config.rads_base_url || !config.rads_issue_key) {
    return {
      ok: false,
      message: "配置缺少 rads_base_url / rads_issue_key，无法调用发卡接口",
    };
  }

  const title = (options.title ?? config.rads_title ?? "TGuard 入群验证卡").trim() || "TGuard 入群验证卡";
  const price = options.price ?? config.rads_price ?? 0;
  const scriptId = options.scriptId ?? config.rads_script_id ?? 0;
  const maxUses = options.maxUses ?? config.rads_max_uses ?? 3;

  if (!scriptId) {
    return {
      ok: false,
      message: "缺少 rads_script_id：请在配置 JSON 中填写交付系统的资源 ID",
    };
  }

  let response: Response;
  try {
    response = await fetch(`${config.rads_base_url}/api/issue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.rads_issue_key}`,
      },
      body: JSON.stringify({
        title,
        price,
        script_id: scriptId,
        max_uses: maxUses,
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `发卡接口请求失败：${detail}` };
  }

  const text = await response.text();
  let payload: RadsIssuePayload | null = null;
  try {
    payload = JSON.parse(text) as RadsIssuePayload;
  } catch {
    payload = null;
  }

  if (!payload || typeof payload !== "object") {
    return { ok: false, message: `发卡接口响应异常（HTTP ${response.status}）` };
  }
  if (!payload.ok || !payload.data?.key) {
    return {
      ok: false,
      message: payload.error ?? `发卡接口返回错误（HTTP ${response.status}）`,
    };
  }

  return {
    ok: true,
    message: "发卡成功",
    key: String(payload.data.key),
    shareUrl: payload.data.url ? String(payload.data.url) : "",
    title: payload.data.title ?? title,
    price: payload.data.price ?? price,
    maxUses: payload.data.max_uses ?? maxUses,
    expiresAt: payload.data.expires_at ?? null,
  };
}
