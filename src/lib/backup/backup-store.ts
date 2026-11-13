/**
 * backup-store — 备份对象存储（v2.2.3，自 xianyu-admin v2.3.10 backup-store.ts 原样复刻）。
 *
 * 优先级 (从高到低):
 *   1. app_settings 配置的 R2/S3 (键名与 xianyu 同款: storage_driver / r2_* / s3_* /
 *      storage_cdn_base_url, SigV4 S3 API):
 *      storage_driver = r2 (endpoint 由 account_id 拼装) | s3 (自定义 endpoint);
 *   2. Cloudflare R2 绑定 (binding "BACKUP_R2") — OpenNext/Workers 部署零配置兜底;
 *   3. local: 本地文件系统 db-snapshots/backups/ — 本地/自托管 Node 兜底。
 *
 * 全部不可用 → getBackupStore 抛错, 前端如实显示存储模式, 绝不静默丢备份。
 */
import { s3Store, type S3Config } from "./s3-client";
import { getDatabase, type SqlDatabase, type SqlRow } from "@/database/client";

export interface BackupObjectMeta {
  key: string;
  size: number;
  modified_at: string;
}

interface R2LikeObject {
  key: string;
  size: number;
  uploaded: Date;
}

/** 最小 R2 bucket 接口 (运行时绑定, 不引入 workers-types)。 */
interface R2LikeBucket {
  put(key: string, value: ArrayBuffer | Uint8Array | string): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  list(opts: { prefix: string }): Promise<{ objects: R2LikeObject[] }>;
  delete(key: string): Promise<unknown>;
}

export interface BackupStore {
  driver: "r2" | "s3" | "local";
  label: string;
  put(key: string, data: ArrayBuffer | Uint8Array | string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  list(): Promise<BackupObjectMeta[]>;
  delete(key: string): Promise<void>;
}

/** 设置页 R2/S3 存储读取结果。 */
export interface StorageSettings {
  driver: "r2" | "s3";
  cdnBaseUrl: string;
  s3Config: S3Config | null;
  /** 未配置齐全时的缺失项说明 (空串 = 已配置齐全) */
  missing: string;
}

/** 读取 app_settings 的 R2/S3 存储配置; 配置齐全时返回可用 S3Config (R2 endpoint 自动拼装)。 */
export async function getStorageSettings(db: SqlDatabase): Promise<StorageSettings> {
  const rows = await db.all<{ key: string; value: string }>(
    `SELECT key, value FROM app_settings WHERE key IN
     ('storage_driver','r2_account_id','r2_access_key_id','r2_secret_access_key','r2_bucket',
      's3_endpoint','s3_region','s3_access_key_id','s3_secret_access_key','s3_bucket','s3_path_style','storage_cdn_base_url')`,
  );
  const s: Record<string, string> = {};
  for (const r of rows) s[r.key] = String(r.value || "");
  const driver: "r2" | "s3" = s.storage_driver === "s3" ? "s3" : "r2";
  const cdnBaseUrl = s.storage_cdn_base_url || "";
  if (driver === "r2") {
    const missing: string[] = [];
    if (!s.r2_account_id) missing.push("R2 账户 ID");
    if (!s.r2_access_key_id) missing.push("R2 Access Key ID");
    if (!s.r2_secret_access_key) missing.push("R2 Secret Access Key");
    if (!s.r2_bucket) missing.push("R2 存储桶名");
    if (missing.length) return { driver, cdnBaseUrl, s3Config: null, missing: missing.join("、") };
    return {
      driver,
      cdnBaseUrl,
      s3Config: {
        endpoint: `https://${s.r2_account_id}.r2.cloudflarestorage.com`,
        region: "auto",
        accessKeyId: s.r2_access_key_id,
        secretAccessKey: s.r2_secret_access_key,
        bucket: s.r2_bucket,
        pathStyle: true,
      },
      missing: "",
    };
  }
  const missing: string[] = [];
  if (!s.s3_endpoint) missing.push("S3 endpoint");
  if (!s.s3_access_key_id) missing.push("S3 Access Key ID");
  if (!s.s3_secret_access_key) missing.push("S3 Secret Access Key");
  if (!s.s3_bucket) missing.push("S3 存储桶名");
  if (missing.length) return { driver, cdnBaseUrl, s3Config: null, missing: missing.join("、") };
  return {
    driver,
    cdnBaseUrl,
    s3Config: {
      endpoint: s.s3_endpoint,
      region: s.s3_region || "us-east-1",
      accessKeyId: s.s3_access_key_id,
      secretAccessKey: s.s3_secret_access_key,
      bucket: s.s3_bucket,
      pathStyle: s.s3_path_style !== "false",
    },
    missing: "",
  };
}

/** 设置配置的 S3 兼容存储 (R2/S3 同一 SigV4 通道)。 */
function settingsStore(cfg: S3Config, driver: "r2" | "s3"): BackupStore {
  const inner = s3Store(cfg);
  const label =
    driver === "r2" ? `Cloudflare R2 (app_settings 配置 · ${cfg.bucket})` : `S3 兼容存储 (app_settings 配置 · ${cfg.bucket})`;
  return {
    driver,
    label,
    async put(key, data) {
      await inner.put(`backups/${key}`, data);
    },
    async get(key) {
      return inner.get(`backups/${key}`);
    },
    async list() {
      const objs = await inner.list("backups/");
      return objs.map((o) => ({ key: o.key.slice("backups/".length), size: o.size, modified_at: o.modified_at }));
    },
    async delete(key) {
      await inner.delete(`backups/${key}`);
    },
  };
}

const R2_PREFIX = "backups/";

/** Cloudflare env 探测：OpenNext 请求上下文 + workerd 全局注入（与 database/client.ts 同一范式）。 */
async function resolveCloudflareEnv(): Promise<Record<string, unknown> | null> {
  const globals = globalThis as unknown as Record<string, unknown>;
  const globalEnv = globals.__env__;
  if (globalEnv && typeof globalEnv === "object" && (globalEnv as Record<string, unknown>).BACKUP_R2) {
    return globalEnv as Record<string, unknown>;
  }
  const requestContextModules = ["@cloudflare/next-on-pages", "@opennextjs/cloudflare"];
  for (const moduleName of requestContextModules) {
    try {
      const importer = new Function(
        "m",
        `return import(/* webpackIgnore: true */ m)`,
      ) as (m: string) => Promise<unknown>;
      const mod = (await importer(moduleName)) as {
        getRequestContext?: () => { env: Record<string, unknown> };
        getCloudflareContext?: () => { env: Record<string, unknown> };
      };
      const getRequestContext = mod.getRequestContext ?? mod.getCloudflareContext;
      if (typeof getRequestContext !== "function") continue;
      const { env } = getRequestContext();
      if (env && typeof env === "object" && env.BACKUP_R2) return env;
    } catch {
      continue;
    }
  }
  return null;
}

function r2Store(bucket: R2LikeBucket): BackupStore {
  return {
    driver: "r2",
    label: "Cloudflare R2 (BACKUP_R2 绑定)",
    async put(key, data) {
      await bucket.put(R2_PREFIX + key, data as unknown as ArrayBuffer);
    },
    async get(key) {
      const obj = await bucket.get(R2_PREFIX + key);
      if (!obj) return null;
      return new Uint8Array(await obj.arrayBuffer());
    },
    async list() {
      const res = await bucket.list({ prefix: R2_PREFIX });
      return (res.objects || [])
        .map((o) => ({ key: o.key.slice(R2_PREFIX.length), size: o.size, modified_at: new Date(o.uploaded).toISOString() }))
        .sort((a, b) => b.modified_at.localeCompare(a.modified_at));
    },
    async delete(key) {
      await bucket.delete(R2_PREFIX + key);
    },
  };
}

/** node:fs 惰性加载（仅本地 Node 运行时会走到 local 分支）。 */
async function nodeFs(): Promise<typeof import("node:fs")> {
  return (await import("node:fs")) as typeof import("node:fs");
}

async function localDir(): Promise<string> {
  const path = (await import("node:path")) as typeof import("node:path");
  return path.join(process.cwd(), "db-snapshots", "backups");
}

/** 防目录穿越: 备份文件名只允许安全字符。 */
function assertSafeKey(key: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(key)) throw new Error(`非法备份文件名: ${key}`);
}

async function localStore(): Promise<BackupStore> {
  const fs = await nodeFs();
  const dir = await localDir();
  const safePath = async (key: string) => {
    assertSafeKey(key);
    const path = (await import("node:path")) as typeof import("node:path");
    return path.join(dir, key);
  };
  return {
    driver: "local",
    label: "本地快照目录 (db-snapshots/backups/)",
    async put(key, data) {
      fs.mkdirSync(dir, { recursive: true });
      const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : Buffer.from(data as Uint8Array);
      fs.writeFileSync(await safePath(key), buf);
    },
    async get(key) {
      const p = await safePath(key);
      if (!fs.existsSync(p)) return null;
      return new Uint8Array(fs.readFileSync(p));
    },
    async list() {
      if (!fs.existsSync(dir)) return [];
      const path = (await import("node:path")) as typeof import("node:path");
      return fs
        .readdirSync(dir)
        .filter((f) => fs.statSync(path.join(dir, f)).isFile())
        .map((f) => {
          const st = fs.statSync(path.join(dir, f));
          return { key: f, size: st.size, modified_at: st.mtime.toISOString() };
        })
        .sort((a, b) => b.modified_at.localeCompare(a.modified_at));
    },
    async delete(key) {
      const p = await safePath(key);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    },
  };
}

/** 取备份存储: app_settings R2/S3 配置优先 → BACKUP_R2 绑定 → Node 回落本地快照目录, 其余形态如实报错。 */
export async function getBackupStore(): Promise<BackupStore> {
  // 1. app_settings 显式配置的 R2/S3 (用户意图优先于平台绑定)
  try {
    const db = await getDatabase();
    const st = await getStorageSettings(db);
    if (st.s3Config) return settingsStore(st.s3Config, st.driver);
  } catch (e) {
    console.error("[getBackupStore] 读取 app_settings 存储配置失败, 继续走绑定/本地链路:", e);
  }
  // 2. Cloudflare R2 平台绑定 (零配置)
  const env = await resolveCloudflareEnv();
  if (env?.BACKUP_R2) return r2Store(env.BACKUP_R2 as R2LikeBucket);
  // 3. Node 本地快照目录
  const db = await getDatabase();
  if (db.kind === "node") return localStore();
  throw new Error("云端备份存储未配置: 请在 app_settings 配置 storage_driver 与 R2/S3 凭据, 或为 Workers 部署配置 R2 绑定 BACKUP_R2");
}

/** 行类型便捷导出（与 operations 层无耦合）。 */
export type BackupSqlRow = SqlRow;
