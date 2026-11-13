/**
 * TGAPI代理 —— 将 my.telegram.org 申请四步调用经 tgapi-proxy-toolkit 代理转发。
 *
 * 代理端点(tgapi-proxy-toolkit worker.js / mytelegram_client.mjs)对外提供:
 *   POST /api/send-code   {phone}                          → {ok, random_hash, cookies}
 *   POST /api/verify-code {phone, random_hash, code, cookies} → {ok, stel_token, cookies}
 *   POST /api/get-app     {stel_token, cookies}            → {ok, app_exists, api_id, api_hash, form_hash}
 *   POST /api/create-app  {stel_token, cookies, app_title, app_shortname, app_platform, app_url, app_desc} → {ok, api_id, api_hash}
 *
 * 鉴权: Authorization: Bearer <APIKEY> 或 Proxy-Authorization: Basic <user:pass>
 *   (与 tgapi-proxy-toolkit 的 APIKEYS / CF_PROXY_USERS 共用)
 *
 * cookies 字段对调用方不透明: 代理端管理 my.telegram.org 会话(stel_ss / stel_token),
 * 调用方只需把上一步返回的 cookies 原样回传下一步。
 */

import { getAppSetting } from "@/database/operations";
import { logApi } from "@/lib/api-log";

export interface TgapiProxyConfig {
  enabled: boolean;
  proxyUrl: string;
  authType: "bearer" | "basic";
  bearerKey: string;
  basicUser: string;
  basicPass: string;
}

const EMPTY_CONFIG: TgapiProxyConfig = {
  enabled: false,
  proxyUrl: "",
  authType: "bearer",
  bearerKey: "",
  basicUser: "",
  basicPass: "",
};

/** 从 app_settings 读取 TGAPI代理配置 */
export async function getTgapiProxyConfig(): Promise<TgapiProxyConfig> {
  const [enabled, url, authType, bearerKey, basicUser, basicPass] = await Promise.all([
    getAppSetting("tgapi_proxy_enabled"),
    getAppSetting("tgapi_proxy_url"),
    getAppSetting("tgapi_proxy_auth_type"),
    getAppSetting("tgapi_proxy_bearer_key"),
    getAppSetting("tgapi_proxy_basic_user"),
    getAppSetting("tgapi_proxy_basic_pass"),
  ]);
  return {
    enabled: enabled === "1" || enabled === "true",
    proxyUrl: (url ?? "").trim().replace(/\/+$/, ""),
    authType: authType === "basic" ? "basic" : "bearer",
    bearerKey: bearerKey ?? "",
    basicUser: basicUser ?? "",
    basicPass: basicPass ?? "",
  };
}

export async function isTgapiProxyEnabled(): Promise<boolean> {
  const cfg = await getTgapiProxyConfig();
  return cfg.enabled && !!cfg.proxyUrl;
}

/** 构造鉴权头 */
function authHeaders(cfg: TgapiProxyConfig): Record<string, string> {
  if (cfg.authType === "basic") {
    if (!cfg.basicUser) return {};
    const cred = btoa(`${cfg.basicUser}:${cfg.basicPass}`);
    return { "Proxy-Authorization": `Basic ${cred}`, Authorization: `Basic ${cred}` };
  }
  if (!cfg.bearerKey) return {};
  return { Authorization: `Bearer ${cfg.bearerKey}` };
}

const PROXY_TIMEOUT_MS = 30000;

interface ProxyCookies {
  [key: string]: string;
}

/** 统一代理请求: POST JSON, 返回解析后的 JSON(失败抛 Error) */
async function proxyPost<T = unknown>(cfg: TgapiProxyConfig, path: string, body: unknown, startedAt: number): Promise<T> {
  const url = `${cfg.proxyUrl}${path}`;
  const requestPayload = JSON.stringify(body);
  let statusCode: number | null = null;
  let responseText = "";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(cfg) },
      body: requestPayload,
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
    statusCode = res.status;
    responseText = await res.text();
    let data: unknown;
    try { data = JSON.parse(responseText); } catch { throw new Error(`TGAPI代理 ${path} 响应非 JSON(HTTP ${res.status}): ${responseText.slice(0, 200)}`); }
    if (!res.ok || (data && typeof data === "object" && (data as { ok?: unknown }).ok !== true)) {
      const errMsg = (data && typeof data === "object" && (data as { error?: unknown }).error) || `HTTP ${res.status}`;
      throw new Error(`TGAPI代理 ${path} 失败: ${errMsg}`);
    }
    logApi({ category: "tgapi", method: `proxy ${path}`, ok: true, statusCode, requestPayload, responseBody: responseText, durationMs: Date.now() - startedAt });
    return data as T;
  } catch (error) {
    logApi({ category: "tgapi", method: `proxy ${path}`, ok: false, statusCode, requestPayload, responseBody: responseText || null, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt });
    throw error;
  }
}

/** step 1: send-code → {randomHash, cookies} */
export async function proxySendCode(phone: string): Promise<{ randomHash: string; cookies: ProxyCookies }> {
  const cfg = await getTgapiProxyConfig();
  if (!cfg.enabled || !cfg.proxyUrl) throw new Error("TGAPI代理未启用");
  const startedAt = Date.now();
  interface SendCodeResp { random_hash?: string; cookies?: ProxyCookies; error?: string }
  const data = await proxyPost<SendCodeResp>(cfg, "/api/send-code", { phone }, startedAt);
  if (typeof data.random_hash !== "string" || !data.random_hash.trim()) {
    throw new Error(`TGAPI代理 send-code 未返回 random_hash: ${data.error ?? ""}`);
  }
  return { randomHash: data.random_hash, cookies: data.cookies ?? {} };
}

/** step 2: verify-code → {ok, stelToken, cookies} */
export async function proxyVerifyCode(phone: string, randomHash: string, code: string, cookies: ProxyCookies): Promise<{ ok: boolean; stelToken: string; cookies: ProxyCookies; error: string }> {
  const cfg = await getTgapiProxyConfig();
  if (!cfg.enabled || !cfg.proxyUrl) throw new Error("TGAPI代理未启用");
  const startedAt = Date.now();
  interface VerifyResp { ok?: boolean; stel_token?: string; cookies?: ProxyCookies; error?: string }
  const data = await proxyPost<VerifyResp>(cfg, "/api/verify-code", { phone, random_hash: randomHash, code, cookies }, startedAt);
  if (data.ok === false) return { ok: false, stelToken: "", cookies: data.cookies ?? cookies, error: data.error ?? "登录失败" };
  if (typeof data.stel_token !== "string" || !data.stel_token.trim()) {
    return { ok: false, stelToken: "", cookies: data.cookies ?? cookies, error: data.error ?? "代理未返回 stel_token" };
  }
  return { ok: true, stelToken: data.stel_token, cookies: data.cookies ?? cookies, error: "" };
}

/** step 3: get-app → {appExists, appId, apiHash, appHash, cookies} */
export async function proxyGetApp(stelToken: string, cookies: ProxyCookies): Promise<{
  appExists: boolean; appId: string; apiHash: string; appHash: string; cookies: ProxyCookies;
}> {
  const cfg = await getTgapiProxyConfig();
  if (!cfg.enabled || !cfg.proxyUrl) throw new Error("TGAPI代理未启用");
  const startedAt = Date.now();
  interface GetAppResp { app_exists?: boolean; api_id?: string | number; api_hash?: string; form_hash?: string; cookies?: ProxyCookies; error?: string }
  const data = await proxyPost<GetAppResp>(cfg, "/api/get-app", { stel_token: stelToken, cookies }, startedAt);
  return {
    appExists: !!data.app_exists,
    appId: String(data.api_id ?? ""),
    apiHash: String(data.api_hash ?? ""),
    appHash: String(data.form_hash ?? ""),
    cookies: data.cookies ?? cookies,
  };
}

/** step 4: create-app → {appId, apiHash, cookies} */
export async function proxyCreateApp(input: {
  stelToken: string; cookies: ProxyCookies; appTitle: string; appShortName: string;
  appPlatform: string; appUrl: string; appDescription: string;
}): Promise<{ appId: string; apiHash: string; cookies: ProxyCookies }> {
  const cfg = await getTgapiProxyConfig();
  if (!cfg.enabled || !cfg.proxyUrl) throw new Error("TGAPI代理未启用");
  const startedAt = Date.now();
  interface CreateResp { api_id?: string | number; api_hash?: string; cookies?: ProxyCookies; error?: string }
  const data = await proxyPost<CreateResp>(cfg, "/api/create-app", {
    stel_token: input.stelToken, cookies: input.cookies,
    app_title: input.appTitle, app_shortname: input.appShortName,
    app_platform: input.appPlatform, app_url: input.appUrl, app_desc: input.appDescription,
  }, startedAt);
  if (!data.api_id || !data.api_hash) throw new Error(`TGAPI代理 create-app 未返回凭据: ${data.error ?? ""}`);
  return { appId: String(data.api_id), apiHash: String(data.api_hash), cookies: data.cookies ?? input.cookies };
}
