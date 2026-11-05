import { session } from "grammy";
import type { StorageAdapter } from "grammy";
import { queryAll, queryOne, executeRun } from "@/database/client";
import { getAppSetting, getAllAppSettings } from "@/database/operations";
import type { BotContext } from "./context";

/**
 * BOT 会话外部存储（v1.1.0）— grammY session StorageAdapter 实现
 *
 * 参考 grammY 官方文档「会话与数据存储」外部存储解决方案：
 * 默认内存（重启丢失）→ 可一键切换到 SQLite / Cloudflare D1 / Cloudflare R2 / S3 兼容对象存储持久存储。
 *
 * 后端解析优先级（bots.config.sessionStorage 单项 > 全局 bot.session_storage）：
 * - inherit：跟随全局配置
 * - memory：内存（grammY 默认，等价于不安装 storage）
 * - sqlite：主数据库 bot_sessions 表（Node 环境）
 * - d1：Cloudflare D1（edge 下自动探测 D1 binding；Node 下走 REST API）
 * - r2：Cloudflare R2（edge 下自动探测 R2 binding；Node 下走 S3 兼容 REST + SigV4）
 * - s3：S3 兼容对象存储（AWS S3 / MinIO / Wasabi / Backblaze 等通用 REST + SigV4）
 */

export type SessionStorageBackend = "memory" | "sqlite" | "d1" | "r2" | "s3";

export const SESSION_STORAGE_SETTING_KEY = "bot.session_storage";

export interface SessionStorageD1Config {
  accountId: string;
  databaseId: string;
  apiToken: string;
}

export interface SessionStorageR2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** CDN 加速域名（可选）：R2 存储桶绑定的自定义域，公开读取走该域名 */
  cdnUrl: string;
}

export interface SessionStorageS3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** true = path-style（endpoint/bucket/key），false = virtual-hosted（bucket.endpoint/key） */
  pathStyle: boolean;
  /** CDN 加速域名（可选）：如 CloudFront 分配域名，公开读取走该域名 */
  cdnUrl: string;
}

export const SESSION_STORAGE_D1_KEYS = {
  accountId: "bot.session_storage_d1_account_id",
  databaseId: "bot.session_storage_d1_database_id",
  apiToken: "bot.session_storage_d1_api_token",
} as const;

export const SESSION_STORAGE_R2_KEYS = {
  accountId: "bot.session_storage_r2_account_id",
  accessKeyId: "bot.session_storage_r2_access_key_id",
  secretAccessKey: "bot.session_storage_r2_secret_access_key",
  bucket: "bot.session_storage_r2_bucket",
  cdnUrl: "bot.session_storage_r2_cdn_url",
} as const;

export const SESSION_STORAGE_S3_KEYS = {
  endpoint: "bot.session_storage_s3_endpoint",
  region: "bot.session_storage_s3_region",
  bucket: "bot.session_storage_s3_bucket",
  accessKeyId: "bot.session_storage_s3_access_key_id",
  secretAccessKey: "bot.session_storage_s3_secret_access_key",
  pathStyle: "bot.session_storage_s3_path_style",
  cdnUrl: "bot.session_storage_s3_cdn_url",
} as const;

export function normalizeSessionBackend(value: unknown): SessionStorageBackend {
  return value === "sqlite" || value === "d1" || value === "r2" || value === "s3" ? value : "memory";
}

async function getSettingValue(key: string): Promise<string> {
  return (await getAppSetting(key)) ?? "";
}

async function getD1Config(): Promise<SessionStorageD1Config> {
  return {
    accountId: await getSettingValue(SESSION_STORAGE_D1_KEYS.accountId),
    databaseId: await getSettingValue(SESSION_STORAGE_D1_KEYS.databaseId),
    apiToken: await getSettingValue(SESSION_STORAGE_D1_KEYS.apiToken),
  };
}

async function getR2Config(): Promise<SessionStorageR2Config> {
  return {
    accountId: await getSettingValue(SESSION_STORAGE_R2_KEYS.accountId),
    accessKeyId: await getSettingValue(SESSION_STORAGE_R2_KEYS.accessKeyId),
    secretAccessKey: await getSettingValue(SESSION_STORAGE_R2_KEYS.secretAccessKey),
    bucket: await getSettingValue(SESSION_STORAGE_R2_KEYS.bucket),
    cdnUrl: await getSettingValue(SESSION_STORAGE_R2_KEYS.cdnUrl),
  };
}

async function getS3Config(): Promise<SessionStorageS3Config> {
  return {
    endpoint: await getSettingValue(SESSION_STORAGE_S3_KEYS.endpoint),
    region: (await getSettingValue(SESSION_STORAGE_S3_KEYS.region)) || "us-east-1",
    bucket: await getSettingValue(SESSION_STORAGE_S3_KEYS.bucket),
    accessKeyId: await getSettingValue(SESSION_STORAGE_S3_KEYS.accessKeyId),
    secretAccessKey: await getSettingValue(SESSION_STORAGE_S3_KEYS.secretAccessKey),
    pathStyle: (await getSettingValue(SESSION_STORAGE_S3_KEYS.pathStyle)) !== "virtual_hosted",
    cdnUrl: await getSettingValue(SESSION_STORAGE_S3_KEYS.cdnUrl),
  };
}

/** 规范化自定义域名：去尾部斜杠；无协议时自动补 https://；返回空串表示未配置 */
export function normalizeCdnUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * 对象公开访问 URL（v1.1.1 CDN 支持）：
 * - 配置了 CDN 加速域名（R2 自定义域 / S3 CloudFront 等）→ https://<cdn>/<objectKey>
 * - 未配置 → 回退源站直连 URL（R2 为 S3 API 域名，S3 按 path/virtual-hosted 寻址）
 * 会话数据（bot_sessions）属私有数据，继续走签名 API 读写；公开 URL 供需要
 * 公开分发的对象（如验证素材、文件分发）使用。
 */
export async function buildStoragePublicUrl(
  backend: "r2" | "s3",
  objectKey: string,
): Promise<{ url: string; viaCdn: boolean; cdnUrl: string }> {
  const key = objectKey.replace(/^\/+/, "");
  if (backend === "r2") {
    const r2 = await getR2Config();
    const cdnUrl = normalizeCdnUrl(r2.cdnUrl);
    if (cdnUrl) {
      return { url: `${cdnUrl}/${key}`, viaCdn: true, cdnUrl };
    }
    return {
      url: `https://${r2.accountId}.r2.cloudflarestorage.com/${r2.bucket}/${key}`,
      viaCdn: false,
      cdnUrl: "",
    };
  }
  const config = await getS3Config();
  const cdnUrl = normalizeCdnUrl(config.cdnUrl);
  if (cdnUrl) {
    return { url: `${cdnUrl}/${key}`, viaCdn: true, cdnUrl };
  }
  try {
    const endpoint = new URL(config.endpoint);
    const url = config.pathStyle
      ? `${endpoint.origin}${endpoint.pathname.replace(/\/+$/, "")}/${config.bucket}/${key}`
      : `${endpoint.protocol}//${config.bucket}.${endpoint.host}${endpoint.pathname.replace(/\/+$/, "")}/${key}`;
    return { url, viaCdn: false, cdnUrl: "" };
  } catch {
    return { url: `/${config.bucket}/${key}`, viaCdn: false, cdnUrl: "" };
  }
}

/** 全局配置 → 存储后端 */
export async function resolveGlobalSessionBackend(): Promise<SessionStorageBackend> {
  return normalizeSessionBackend(await getSettingValue(SESSION_STORAGE_SETTING_KEY));
}

/** 单项配置（inherit/memory/sqlite/d1/r2/s3）→ 实际后端 */
export async function resolveEffectiveSessionBackend(single?: string): Promise<SessionStorageBackend> {
  if (single && single !== "inherit") return normalizeSessionBackend(single);
  return resolveGlobalSessionBackend();
}

// ---------------------------------------------------------------------------
// SQLite 适配器（主库 bot_sessions 表）
// ---------------------------------------------------------------------------

interface StorageAdapterLike {
  /** key 由调用方编码（grammY 默认 chat id；建议带 bot 前缀隔离多 bot 会话） */
  read(key: string): Promise<unknown | undefined>;
  write(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

const SESSION_SCOPE = "session";

let sqliteTableReady = false;

async function ensureSqliteTable(): Promise<void> {
  if (sqliteTableReady) return;
  await executeRun(
    `CREATE TABLE IF NOT EXISTS "bot_sessions" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "scope" TEXT NOT NULL DEFAULT 'session',
      "session_key" TEXT NOT NULL,
      "value" TEXT NOT NULL DEFAULT '{}',
      "updated_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  );
  await executeRun(
    `CREATE UNIQUE INDEX IF NOT EXISTS "bot_sessions_scope_key" ON "bot_sessions"("scope", "session_key")`,
  );
  sqliteTableReady = true;
}

function createSqliteAdapter(): StorageAdapterLike {
  return {
    async read(key) {
      await ensureSqliteTable();
      const row = await queryOne<{ value: string }>(
        `SELECT value FROM bot_sessions WHERE scope = ? AND session_key = ?`,
        [SESSION_SCOPE, key],
      );
      if (!row) return undefined;
      try {
        return JSON.parse(row.value) as unknown;
      } catch {
        return undefined;
      }
    },
    async write(key, value) {
      await ensureSqliteTable();
      const json = JSON.stringify(value ?? {});
      await executeRun(
        `INSERT INTO bot_sessions (scope, session_key, value, updated_time) VALUES (?, ?, ?, ?)
         ON CONFLICT(scope, session_key) DO UPDATE SET value = excluded.value, updated_time = excluded.updated_time`,
        [SESSION_SCOPE, key, json, new Date().toISOString()],
      );
    },
    async delete(key) {
      await ensureSqliteTable();
      await executeRun(`DELETE FROM bot_sessions WHERE scope = ? AND session_key = ?`, [SESSION_SCOPE, key]);
    },
  };
}

// ---------------------------------------------------------------------------
// D1 适配器（edge binding 优先，Node 回退 REST API）
// ---------------------------------------------------------------------------

interface D1RestResponse {
  success?: boolean;
  errors?: { message?: string }[];
  result?: { results?: Record<string, unknown>[] }[];
}

async function d1Query(config: SessionStorageD1Config, sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/storage/d1/database/${encodeURIComponent(config.databaseId)}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
      signal: AbortSignal.timeout(15000),
    },
  );
  const payload = (await response.json()) as D1RestResponse;
  if (!response.ok || payload.success === false) {
    const message = payload.errors?.[0]?.message ?? `HTTP ${response.status}`;
    throw new Error(`D1 查询失败: ${message}`);
  }
  return payload.result?.[0]?.results ?? [];
}

let d1TableReady = false;

async function ensureD1Table(d1: unknown): Promise<void> {
  if (d1TableReady) return;
  const binding = d1 as { prepare(sql: string): { run(): Promise<unknown> } };
  await binding
    .prepare(
      `CREATE TABLE IF NOT EXISTS bot_sessions (scope TEXT NOT NULL DEFAULT 'session', session_key TEXT NOT NULL, value TEXT NOT NULL DEFAULT '{}', updated_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (scope, session_key))`,
    )
    .run();
  d1TableReady = true;
}

function createD1BindingAdapter(binding: unknown): StorageAdapterLike {
  const d1 = binding as {
    prepare(sql: string): {
      bind(...params: unknown[]): {
        all(): Promise<{ results?: Record<string, unknown>[] }>;
        run(): Promise<unknown>;
      };
    };
  };
  return {
    async read(key) {
      await ensureD1Table(binding);
      const result = await d1
        .prepare(`SELECT value FROM bot_sessions WHERE scope = ? AND session_key = ?`)
        .bind(SESSION_SCOPE, key)
        .all();
      const row = result.results?.[0];
      if (!row) return undefined;
      try {
        return JSON.parse(String(row.value ?? "{}")) as unknown;
      } catch {
        return undefined;
      }
    },
    async write(key, value) {
      await ensureD1Table(binding);
      const json = JSON.stringify(value ?? {});
      await d1
        .prepare(
          `INSERT INTO bot_sessions (scope, session_key, value, updated_time) VALUES (?, ?, ?, ?) ON CONFLICT(scope, session_key) DO UPDATE SET value = excluded.value, updated_time = excluded.updated_time`,
        )
        .bind(SESSION_SCOPE, key, json, new Date().toISOString())
        .run();
    },
    async delete(key) {
      await ensureD1Table(binding);
      await d1.prepare(`DELETE FROM bot_sessions WHERE scope = ? AND session_key = ?`).bind(SESSION_SCOPE, key).run();
    },
  };
}

function createD1RestAdapter(config: SessionStorageD1Config): StorageAdapterLike {
  let restTableReady = false;
  const ensureRestTable = async (): Promise<void> => {
    if (restTableReady) return;
    await d1Query(
      config,
      `CREATE TABLE IF NOT EXISTS bot_sessions (scope TEXT NOT NULL DEFAULT 'session', session_key TEXT NOT NULL, value TEXT NOT NULL DEFAULT '{}', updated_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (scope, session_key))`,
      [],
    );
    restTableReady = true;
  };
  return {
    async read(key) {
      await ensureRestTable();
      const rows = await d1Query(config, `SELECT value FROM bot_sessions WHERE scope = ? AND session_key = ?`, [SESSION_SCOPE, key]);
      if (!rows[0]) return undefined;
      try {
        return JSON.parse(String(rows[0].value ?? "{}")) as unknown;
      } catch {
        return undefined;
      }
    },
    async write(key, value) {
      await ensureRestTable();
      const json = JSON.stringify(value ?? {});
      await d1Query(
        config,
        `INSERT INTO bot_sessions (scope, session_key, value, updated_time) VALUES (?, ?, ?, ?) ON CONFLICT(scope, session_key) DO UPDATE SET value = excluded.value, updated_time = excluded.updated_time`,
        [SESSION_SCOPE, key, json, new Date().toISOString()],
      );
    },
    async delete(key) {
      await ensureRestTable();
      await d1Query(config, `DELETE FROM bot_sessions WHERE scope = ? AND session_key = ?`, [SESSION_SCOPE, key]);
    },
  };
}

function resolveD1Binding(): unknown | null {
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const key of ["DATABASE", "__D1_DATABASE"]) {
    const candidate = globals[key];
    if (candidate && typeof (candidate as { prepare?: unknown }).prepare === "function") return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// S3 兼容对象存储（R2 / AWS S3 / MinIO 通用 REST + SigV4，WebCrypto 同构签名）
// ---------------------------------------------------------------------------

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  return new Uint8Array(signature);
}

async function hmacSha256String(key: string, data: string): Promise<Uint8Array> {
  return hmacSha256(new TextEncoder().encode(key), data);
}

interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/** AWS SigV4 签名（service=s3；R2 region=auto，AWS S3 用真实 region） */
async function sigv4Headers(
  url: URL,
  credentials: SigV4Credentials,
  region: string,
  method: "PUT" | "GET" | "DELETE",
  body: string,
): Promise<Record<string, string>> {
  const now = new Date();
  const amzDate = `${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(body);
  const canonicalUri = url.pathname;
  const canonicalHeaders =
    `host:${url.host}\n` + `x-amz-content-sha256:${payloadHash}\n` + `x-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [method, canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
  let signingKey = await hmacSha256String(`AWS4${credentials.secretAccessKey}`, dateStamp);
  signingKey = await hmacSha256(signingKey, region);
  signingKey = await hmacSha256(signingKey, "s3");
  signingKey = await hmacSha256(signingKey, "aws4_request");
  const signatureBytes = await hmacSha256(signingKey, stringToSign);
  const signature = Array.from(signatureBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
}

/** R2 专用对象 URL（accountId.r2.cloudflarestorage.com，region 固定 auto） */
function createR2RestAdapter(config: SessionStorageR2Config): StorageAdapterLike {
  const objectUrl = (key: string): URL =>
    new URL(`https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}/${key}`);
  return {
    async read(key) {
      const url = objectUrl(`sessions/${encodeURIComponent(key)}.json`);
      const headers = await sigv4Headers(url, config, "auto", "GET", "");
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`R2 读取失败: HTTP ${response.status}`);
      try {
        return (await response.json()) as unknown;
      } catch {
        return undefined;
      }
    },
    async write(key, value) {
      const url = objectUrl(`sessions/${encodeURIComponent(key)}.json`);
      const body = JSON.stringify(value ?? {});
      const headers = await sigv4Headers(url, config, "auto", "PUT", body);
      const response = await fetch(url, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`R2 写入失败: HTTP ${response.status}`);
    },
    async delete(key) {
      const url = objectUrl(`sessions/${encodeURIComponent(key)}.json`);
      const headers = await sigv4Headers(url, config, "auto", "DELETE", "");
      await fetch(url, { method: "DELETE", headers, signal: AbortSignal.timeout(15000) });
    },
  };
}

/** 通用 S3 兼容适配器（AWS S3 / MinIO / Wasabi / Backblaze B2 等） */
function createS3RestAdapter(config: SessionStorageS3Config): StorageAdapterLike {
  const endpoint = new URL(config.endpoint);
  const objectUrl = (key: string): URL => {
    if (config.pathStyle) {
      return new URL(`${endpoint.origin}${endpoint.pathname.replace(/\/+$/, "")}/${config.bucket}/${key}`);
    }
    return new URL(`${endpoint.protocol}//${config.bucket}.${endpoint.host}${endpoint.pathname.replace(/\/+$/, "")}/${key}`);
  };
  return {
    async read(key) {
      const url = objectUrl(`sessions/${encodeURIComponent(key)}.json`);
      const headers = await sigv4Headers(url, config, config.region, "GET", "");
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`S3 读取失败: HTTP ${response.status}`);
      try {
        return (await response.json()) as unknown;
      } catch {
        return undefined;
      }
    },
    async write(key, value) {
      const url = objectUrl(`sessions/${encodeURIComponent(key)}.json`);
      const body = JSON.stringify(value ?? {});
      const headers = await sigv4Headers(url, config, config.region, "PUT", body);
      const response = await fetch(url, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`S3 写入失败: HTTP ${response.status}`);
    },
    async delete(key) {
      const url = objectUrl(`sessions/${encodeURIComponent(key)}.json`);
      const headers = await sigv4Headers(url, config, config.region, "DELETE", "");
      await fetch(url, { method: "DELETE", headers, signal: AbortSignal.timeout(15000) });
    },
  };
}

function resolveR2Binding(): unknown | null {
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const key of ["BUCKET", "R2", "__R2_BUCKET"]) {
    const candidate = globals[key];
    if (
      candidate &&
      typeof (candidate as { put?: unknown }).put === "function" &&
      typeof (candidate as { get?: unknown }).get === "function"
    ) {
      return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 工厂：解析后端 → grammY StorageAdapter（null = 内存默认）
// ---------------------------------------------------------------------------

const globalForAdapter = globalThis as unknown as {
  tguardSessionAdapter?: { backend: SessionStorageBackend; key: string; adapter: StorageAdapterLike };
};

export interface SessionStorageResolution {
  backend: SessionStorageBackend;
  /** null = 使用 grammY 内存默认 */
  adapter: StorageAdapterLike | null;
  detail: string;
}

export async function createSessionAdapter(
  backend: SessionStorageBackend,
): Promise<SessionStorageResolution> {
  if (backend === "memory") {
    return { backend, adapter: null, detail: "内存（重启后丢失）" };
  }
  if (backend === "sqlite") {
    return { backend, adapter: createSqliteAdapter(), detail: "SQLite bot_sessions 表" };
  }
  if (backend === "d1") {
    const binding = resolveD1Binding();
    if (binding) {
      return { backend, adapter: createD1BindingAdapter(binding), detail: "Cloudflare D1（binding）" };
    }
    const config = await getD1Config();
    if (!config.accountId || !config.databaseId || !config.apiToken) {
      return { backend: "memory", adapter: null, detail: "D1 配置不完整（account_id / database_id / api_token），回退内存" };
    }
    return { backend, adapter: createD1RestAdapter(config), detail: `Cloudflare D1（REST: ${config.databaseId.slice(0, 8)}…）` };
  }
  if (backend === "s3") {
    const config = await getS3Config();
    if (!config.endpoint || !config.accessKeyId || !config.secretAccessKey || !config.bucket) {
      return { backend: "memory", adapter: null, detail: "S3 配置不完整（endpoint / access_key / secret / bucket），回退内存" };
    }
    return {
      backend,
      adapter: createS3RestAdapter(config),
      detail: `S3 兼容存储（${new URL(config.endpoint).host}/${config.bucket}）`,
    };
  }
  // r2
  const binding = resolveR2Binding();
  if (binding) {
    return { backend, adapter: createR2BindingAdapter(binding), detail: "Cloudflare R2（binding）" };
  }
  const config = await getR2Config();
  if (!config.accountId || !config.accessKeyId || !config.secretAccessKey || !config.bucket) {
    return { backend: "memory", adapter: null, detail: "R2 配置不完整（account_id / access_key / secret / bucket），回退内存" };
  }
  return { backend, adapter: createR2RestAdapter(config), detail: `Cloudflare R2（REST: ${config.bucket}）` };
}

function createR2BindingAdapter(binding: unknown): StorageAdapterLike {
  const r2 = binding as {
    get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
    put(key: string, value: string): Promise<unknown>;
    delete(key: string): Promise<unknown>;
  };
  return {
    async read(key) {
      const object = await r2.get(`sessions/${encodeURIComponent(key)}.json`);
      if (!object) return undefined;
      try {
        return JSON.parse(new TextDecoder().decode(await object.arrayBuffer())) as unknown;
      } catch {
        return undefined;
      }
    },
    async write(key, value) {
      await r2.put(`sessions/${encodeURIComponent(key)}.json`, JSON.stringify(value ?? {}));
    },
    async delete(key) {
      await r2.delete(`sessions/${encodeURIComponent(key)}.json`);
    },
  };
}

/**
 * 解析生效的 session 存储（带全局缓存；配置 hash 变化时重建）
 */
export async function resolveSessionStorage(single?: string): Promise<SessionStorageResolution> {
  const backend = await resolveEffectiveSessionBackend(single);
  if (backend === "memory") {
    return { backend, adapter: null, detail: "内存（重启后丢失）" };
  }
  const configHash = JSON.stringify({
    d1: await getD1Config(),
    r2: await getR2Config(),
    s3: await getS3Config(),
  });
  const cached = globalForAdapter.tguardSessionAdapter;
  if (cached && cached.backend === backend && cached.key === configHash) {
    return { backend, adapter: cached.adapter, detail: "cached" };
  }
  const resolution = await createSessionAdapter(backend);
  if (resolution.adapter) {
    globalForAdapter.tguardSessionAdapter = { backend, key: configHash, adapter: resolution.adapter };
  }
  return resolution;
}

// ---------------------------------------------------------------------------
// grammY session 中间件组装
// ---------------------------------------------------------------------------

export interface BotSessionData {
  /** AI 客服多轮历史（最近 8 条，轮转覆盖） */
  aiHistory?: { role: "user" | "assistant"; content: string }[];
}

export type BotSessionContext = BotContext;

/**
 * 组装 session 中间件（供 createBot / createMenuBot 调用）。
 * backend=memory 或解析失败时不安装自定义 storage（grammY 默认内存）。
 * 注意 grammY session 泛型顺序：<SessionData, Context>。
 */
export async function buildSessionMiddleware(single?: string) {
  const resolution = await resolveSessionStorage(single);
  if (!resolution.adapter) {
    return { middleware: session<BotSessionData, BotContext>({ initial: () => ({}) }), resolution };
  }
  return {
    middleware: session<BotSessionData, BotContext>({
      initial: () => ({}),
      // 内部 JSON 序列化往返，结构与 grammY StorageAdapter<BotSessionData> 等价
      storage: resolution.adapter as unknown as StorageAdapter<BotSessionData>,
    }),
    resolution,
  };
}

/** 供管理后台「测试连接」按钮使用：对目标后端做一次 read/write/delete 往返 */
export async function testSessionStorage(backend: SessionStorageBackend): Promise<{ ok: boolean; detail: string; latencyMs: number }> {
  const started = Date.now();
  try {
    const resolution = await createSessionAdapter(backend);
    if (!resolution.adapter) {
      return { ok: false, detail: resolution.detail, latencyMs: Date.now() - started };
    }
    const adapter = resolution.adapter;
    const probeKey = `__probe_${Date.now()}`;
    const probeValue = { ping: "tguard", at: new Date().toISOString() };
    await adapter.write(probeKey, probeValue);
    const readBack = await adapter.read(probeKey);
    await adapter.delete(probeKey);
    const ok = JSON.stringify(readBack) === JSON.stringify(probeValue);
    return {
      ok,
      detail: ok
        ? `${resolution.detail} 往返读写正常`
        : `${resolution.detail} 读回数据不一致（read= ${JSON.stringify(readBack)}）`,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - started,
    };
  }
}

/** 统计当前 sqlite 会话行数（设置页展示） */
export async function countSqliteSessions(): Promise<number> {
  try {
    await ensureSqliteTable();
    const row = await queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM bot_sessions`);
    return Number(row?.total ?? 0);
  } catch {
    return 0;
  }
}

export async function listSessionBackendHealth(): Promise<{ backend: SessionStorageBackend; rows: number }[]> {
  await ensureSqliteTable();
  const rows = await queryAll<{ scope: string; total: number }>(
    `SELECT scope, COUNT(*) AS total FROM bot_sessions GROUP BY scope`,
  );
  return rows.map((row) => ({ backend: "sqlite" as const, rows: Number(row.total) }));
}

// ---------------------------------------------------------------------------
// 公开配置形态（敏感字段打码）—— v2.0.3：设置页 RSC 首屏直传与 GET 路由共用，
// 页面初始加载不再多发一次 /api/admin/session-storage 请求
// ---------------------------------------------------------------------------

export interface PublicSessionStorageConfig {
  backend: string;
  sqlite_sessions: number;
  d1: { account_id: string; database_id: string; api_token_masked: string; has_api_token: boolean };
  r2: {
    account_id: string;
    access_key_id: string;
    secret_masked: string;
    has_secret: boolean;
    bucket: string;
    cdn_url: string;
  };
  s3: {
    endpoint: string;
    region: string;
    bucket: string;
    access_key_id: string;
    secret_masked: string;
    has_secret: boolean;
    path_style: string;
    cdn_url: string;
  };
}

function maskSecret(value: string | undefined): string {
  return !value ? "" : value.length > 8 ? `${value.slice(0, 4)}****${value.slice(-4)}` : "****";
}

/** 读取当前会话存储配置（敏感字段打码；纯本地 DB，毫秒级） */
export async function getPublicSessionStorageConfig(): Promise<PublicSessionStorageConfig> {
  const stored = await getAllAppSettings();
  return {
    backend: stored[SESSION_STORAGE_SETTING_KEY] ?? "memory",
    sqlite_sessions: await countSqliteSessions(),
    d1: {
      account_id: stored[SESSION_STORAGE_D1_KEYS.accountId] ?? "",
      database_id: stored[SESSION_STORAGE_D1_KEYS.databaseId] ?? "",
      api_token_masked: maskSecret(stored[SESSION_STORAGE_D1_KEYS.apiToken]),
      has_api_token: Boolean(stored[SESSION_STORAGE_D1_KEYS.apiToken]),
    },
    r2: {
      account_id: stored[SESSION_STORAGE_R2_KEYS.accountId] ?? "",
      access_key_id: stored[SESSION_STORAGE_R2_KEYS.accessKeyId] ?? "",
      secret_masked: maskSecret(stored[SESSION_STORAGE_R2_KEYS.secretAccessKey]),
      has_secret: Boolean(stored[SESSION_STORAGE_R2_KEYS.secretAccessKey]),
      bucket: stored[SESSION_STORAGE_R2_KEYS.bucket] ?? "",
      cdn_url: stored[SESSION_STORAGE_R2_KEYS.cdnUrl] ?? "",
    },
    s3: {
      endpoint: stored[SESSION_STORAGE_S3_KEYS.endpoint] ?? "",
      region: stored[SESSION_STORAGE_S3_KEYS.region] ?? "",
      bucket: stored[SESSION_STORAGE_S3_KEYS.bucket] ?? "",
      access_key_id: stored[SESSION_STORAGE_S3_KEYS.accessKeyId] ?? "",
      secret_masked: maskSecret(stored[SESSION_STORAGE_S3_KEYS.secretAccessKey]),
      has_secret: Boolean(stored[SESSION_STORAGE_S3_KEYS.secretAccessKey]),
      path_style:
        (stored[SESSION_STORAGE_S3_KEYS.pathStyle] ?? "path") === "virtual_hosted"
          ? "virtual_hosted"
          : "path",
      cdn_url: stored[SESSION_STORAGE_S3_KEYS.cdnUrl] ?? "",
    },
  };
}
