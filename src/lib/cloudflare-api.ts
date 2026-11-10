/**
 * cloudflare-api — Cloudflare REST API 共享探测层（v2.2.6）
 *
 * 与 .github/workflows/pages-deploy.yml「Resolve Cloudflare account ID /
 * Create R2 bucket」步骤同源的探测方式：
 * - 账号 ID：GET /client/v4/accounts（Bearer Token）→ 取第一个账号 id；
 *   单账号 Token 无需 CLOUDFLARE_ACCOUNT_ID 即可自动探测（workflow 同语义）。
 * - D1 库列表：GET /accounts/{id}/storage/d1/database → result[].uuid
 * - R2 桶列表：GET /accounts/{id}/r2/buckets → result.buckets[].name
 *   （[code:10042] = R2 服务未开通，与 Token 权限无关，透传原文案供指引）
 *
 * 缓存：探测成功结果进程内 memo 5 分钟（多调用方共享，避免重复打 API 消耗配额）；
 * 失败不缓存 —— 配置修好后下一次调用立即重试，错误信息完整返回绝不静默。
 */

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

interface CfListResponse<T> {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: T;
}

/** 进程内缓存：账号 ID 探测结果（key = token 指纹，避免把 token 本身做 key 泄露到内存转储） */
const PROBE_CACHE_TTL_MS = 5 * 60 * 1000;
const accountIdCache = new Map<string, { value: string; at: number }>();

function tokenFingerprint(apiToken: string): string {
  // 仅取哈希片段做缓存 key，绝不缓存/记录 token 本身
  let hash = 0;
  for (let i = 0; i < apiToken.length; i += 1) {
    hash = (hash * 31 + apiToken.charCodeAt(i)) | 0;
  }
  return String(hash);
}

async function cfFetchJson<T>(path: string, apiToken: string): Promise<T> {
  const response = await fetch(`${CF_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${apiToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  const payload = (await response.json()) as CfListResponse<T>;
  if (!response.ok || payload.success === false) {
    const code = payload.errors?.[0]?.code;
    const message = payload.errors?.[0]?.message ?? `HTTP ${response.status}`;
    const hint = code === 10042 ? "（R2 服务未在此账号开通，与 Token 权限无关，请先在 Cloudflare Dashboard 开通 R2）" : "";
    throw new Error(`Cloudflare API ${path} 失败: ${message}${hint}`);
  }
  return payload.result as T;
}

/**
 * 用 API Token 自动探测 Cloudflare 账号 ID（pages-deploy.yml「Resolve Cloudflare
 * account ID」步骤同源）：GET /client/v4/accounts 取第一个账号 id。
 * 单账号 Token 要求具备 Account Settings:Read（workflow 同要求）。
 */
export async function probeCloudflareAccountId(apiToken: string): Promise<string> {
  const token = apiToken.trim();
  if (!token) throw new Error("probeCloudflareAccountId: apiToken 为空");
  const fingerprint = tokenFingerprint(token);
  const cached = accountIdCache.get(fingerprint);
  if (cached && Date.now() - cached.at < PROBE_CACHE_TTL_MS) return cached.value;

  const accounts = await cfFetchJson<{ id?: string; name?: string }[]>("/accounts", token);
  const accountId = accounts?.[0]?.id ?? "";
  if (!accountId) throw new Error("Cloudflare API /accounts 成功但未解析出账号 ID（Token 可能缺少 Account Settings:Read 权限）");
  accountIdCache.set(fingerprint, { value: accountId, at: Date.now() });
  return accountId;
}

export interface CloudflareD1DatabaseInfo {
  uuid: string;
  name: string;
}

/** 列出账号下全部 D1 数据库（GET /accounts/{id}/storage/d1/database） */
export async function listCloudflareD1Databases(apiToken: string, accountId: string): Promise<CloudflareD1DatabaseInfo[]> {
  const result = await cfFetchJson<
    { uuid?: string; id?: string; name?: string }[] | { results?: { uuid?: string; id?: string; name?: string }[] }
  >(`/accounts/${encodeURIComponent(accountId)}/storage/d1/database`, apiToken.trim());
  // 兼容顶层数组与 { results: [...] } 两种响应包装（workflow jq 同口径）
  const rows = Array.isArray(result) ? result : (result?.results ?? []);
  return rows
    .map((row) => ({ uuid: String(row.uuid ?? row.id ?? ""), name: String(row.name ?? "") }))
    .filter((row) => row.uuid !== "");
}

export interface CloudflareR2BucketInfo {
  name: string;
}

/** 列出账号下全部 R2 存储桶（GET /accounts/{id}/r2/buckets，兼容 result.buckets 与顶层数组包装） */
export async function listCloudflareR2Buckets(apiToken: string, accountId: string): Promise<CloudflareR2BucketInfo[]> {
  const result = await cfFetchJson<{ buckets?: { name?: string }[] } | { name?: string }[]>(
    `/accounts/${encodeURIComponent(accountId)}/r2/buckets`,
    apiToken.trim(),
  );
  const rows = Array.isArray(result) ? result : (result?.buckets ?? []);
  return rows
    .map((row) => ({ name: String(row.name ?? "") }))
    .filter((row) => row.name !== "");
}
