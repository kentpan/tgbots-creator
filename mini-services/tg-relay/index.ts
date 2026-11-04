/**
 * TGuard tg-relay：本地 Telegram Bot API 中继服务（端口 3010）
 *
 * 用途：沙盒/国内服务器无法直连 api.telegram.org 时，本服务把 Bot API 请求
 * 通过 z-ai page_reader 国际隧道转发（GET 化），对 grammY / 业务层伪装成一台
 * 标准 Bot API 服务器（grammY 只需设置 apiRoot=http://127.0.0.1:3010）。
 *
 * 支持：
 * - POST /bot<token>/<method>   JSON body（grammY 默认 apiMode）
 * - GET  /bot<token>/<method>?a=b&c=d   原生 GET 透传
 * - GET  /healthz               健康检查
 *
 * 限制：
 * - multipart 文件上传（InputFile 二进制）在隧道模式不支持，返回明确错误
 * - getUpdates 的 long-poll timeout 会被钳制到 <= 5 秒，避免隧道超时
 * - token 会经过 page_reader 网关，生产环境请使用直连 / 自建反代（TELEGRAM_API_ROOT）
 */
import ZAI from "z-ai-web-dev-sdk";

const PORT = 3010;
const UPSTREAM = (process.env.TELEGRAM_UPSTREAM ?? "https://api.telegram.org").replace(/\/+$/, "");
const MAX_LONG_POLL_SECONDS = 5;

interface PageReaderResult {
  code?: number;
  status?: number;
  data?: { html?: string; title?: string };
}

let zaiPromise: Promise<InstanceType<typeof ZAI>> | null = null;
function getZai(): Promise<InstanceType<typeof ZAI>> {
  if (!zaiPromise) zaiPromise = ZAI.create();
  return zaiPromise;
}

function maskToken(token: string): string {
  return token.length > 12 ? `${token.slice(0, 6)}••••${token.slice(-4)}` : "••••";
}

/** 把 JSON body / GET query 归一成 Bot API GET 查询串（嵌套值 JSON.stringify，Telegram 官方兼容） */
function buildQuery(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "object") {
      search.set(key, JSON.stringify(value));
    } else {
      search.set(key, String(value));
    }
  }
  // long-poll 钳制：隧道不支持长时间挂起
  if (search.has("timeout")) {
    const t = Number(search.get("timeout"));
    if (Number.isFinite(t) && t > MAX_LONG_POLL_SECONDS) search.set("timeout", String(MAX_LONG_POLL_SECONDS));
  }
  return search.toString();
}

/** 从 page_reader 返回的 HTML 中提取 Telegram JSON 响应 */
function extractJson(html: string): Record<string, unknown> {
  let text = html.trim();
  // 常见形态：<html>...<pre>{json}</pre>...</html> 或纯 JSON
  const preMatch = text.match(/<pre>([\s\S]*?)<\/pre>/i);
  if (preMatch) text = preMatch[1];
  text = text
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`隧道响应不是合法 JSON：${text.slice(0, 120)}`);
  }
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
}

async function tunnelCall(token: string, method: string, query: string): Promise<Record<string, unknown>> {
  const url = `${UPSTREAM}/bot${token}/${method}${query ? `?${query}` : ""}`;
  const zai = await getZai();
  const result = (await zai.functions.invoke("page_reader", { url })) as PageReaderResult;
  const html = result?.data?.html ?? "";
  if (!html.trim()) {
    throw new Error(`隧道无响应内容（code=${result?.code ?? "?"} status=${result?.status ?? "?"}）`);
  }
  return extractJson(html);
}

function jsonError(errorCode: number, description: string): Response {
  return Response.json({ ok: false, error_code: errorCode, description });
}

async function handleBotApi(token: string, method: string, params: Record<string, unknown>, req: Request): Promise<Response> {
  // 文件上传检测：POST multipart 中含二进制文件时给出明确错误
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null);
    if (form) {
      for (const value of form.values()) {
        if (typeof value !== "string") {
          return jsonError(400, `tg-relay: 隧道模式不支持文件上传（method=${method}）。请使用 file_id/URL 或切换直连模式。`);
        }
      }
      const flat: Record<string, unknown> = {};
      for (const [k, v] of form.entries()) flat[k] = typeof v === "string" ? v : undefined;
      const query = buildQuery(flat);
      const payload = await tunnelCall(token, method, query).catch((e: Error) => ({ __err: e.message }));
      if ("__err" in payload) return jsonError(502, `tg-relay: ${payload.__err}`);
      return Response.json(payload);
    }
  }

  const query = buildQuery(params);
  try {
    const payload = await tunnelCall(token, method, query);
    if (payload.ok !== true) {
      console.log(`[tg-relay] ${method} -> error_code=${payload.error_code} desc=${String(payload.description ?? "").slice(0, 120)} token=${maskToken(token)}`);
    } else {
      console.log(`[tg-relay] ${method} -> ok token=${maskToken(token)}`);
    }
    return Response.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[tg-relay] ${method} -> tunnel failed: ${message.slice(0, 200)}`);
    return jsonError(502, `tg-relay: 隧道转发失败：${message.slice(0, 200)}`);
  }
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/healthz") {
    return Response.json({ ok: true, service: "tg-relay", upstream: UPSTREAM });
  }

  const match = path.match(/^\/bot([^/]+)\/([A-Za-z0-9_]+)$/);
  if (!match) {
    if (/^\/file\/bot/.test(path)) {
      return jsonError(400, "tg-relay: 隧道模式不支持文件下载（/file/...）。");
    }
    return jsonError(404, "tg-relay: 未知的 Bot API 路径，应为 /bot<token>/<method>");
  }
  const [, token, method] = match;

  if (req.method === "GET") {
    const params: Record<string, unknown> = {};
    for (const [k, v] of url.searchParams.entries()) params[k] = v;
    return handleBotApi(token, method, params, req);
  }
  if (req.method === "POST") {
    const contentType = req.headers.get("content-type") ?? "";
    let params: Record<string, unknown> = {};
    if (contentType.includes("application/json")) {
      params = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    } else if (contentType.includes("multipart/form-data")) {
      // handleBotApi 内部处理
      return handleBotApi(token, method, params, req);
    } else {
      const text = await req.text();
      for (const pair of new URLSearchParams(text).entries()) params[pair[0]] = pair[1];
    }
    return handleBotApi(token, method, params, req);
  }
  return jsonError(405, `tg-relay: 不支持的方法 ${req.method}`);
}

Bun.serve({
  port: PORT,
  fetch: handle,
});

console.log(`[tg-relay] listening on http://127.0.0.1:${PORT} -> upstream ${UPSTREAM} (via page_reader tunnel)`);
