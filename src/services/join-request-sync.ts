/**
 * 加群申请远程同步（本地 Node 环境专用）：
 *
 * 背景：同一 bot Token 的 getUpdates 与 Webhook 在 Telegram 侧严格互斥 ——
 * 本地开发环境让位线上 Webhook 消费者后（v2.0.10 远程消费者守卫），
 * 加群申请只会记入线上库（Cloudflare D1），本地库永远看不到新数据。
 * 本服务把线上 join_requests 按 request_time 增量拉回本地（INSERT OR IGNORE
 * 按 verification_token 幂等去重），两侧管理后台获得一致视图。
 *
 * 启用条件（两项都配置才生效）：
 *   SYNC_REMOTE_URL    线上应用地址（如 https://tgbots.ccwu.cc）
 *   SYNC_REMOTE_SECRET 与线上 MIRROR_RELAY_SECRET 一致的共享密钥
 * 水位存 app_settings(sync.join_requests_since)，重启续传不重复导入。
 */
import { createHmac } from "node:crypto";
import { executeRun } from "@/database/client";
import { getAppSetting, getCachedAppSettings, setAppSetting } from "@/database/operations";

const SINCE_KEY = "sync.join_requests_since";
const URL_KEY = "sync.remote_url";
const SECRET_KEY = "sync.remote_secret";
const PAGE_LIMIT = 500;
const MAX_PAGES = 40;

function signHeaders(secret: string): { "x-mirror-timestamp": string; "x-mirror-signature": string } {
  const ts = String(Date.now());
  return {
    "x-mirror-timestamp": ts,
    "x-mirror-signature": createHmac("sha256", secret).update(`${ts}.`).digest("hex"),
  };
}

export interface RemoteSyncConfig {
  baseUrl: string;
  secret: string;
}

/** 同步配置：DB（后台「系统设置」）优先 → 环境变量回退（存量部署兼容） */
export async function resolveRemoteSyncConfig(): Promise<RemoteSyncConfig> {
  let url = "";
  let secret = "";
  try {
    const settings = await getCachedAppSettings();
    url = (settings[URL_KEY] ?? "").trim();
    secret = (settings[SECRET_KEY] ?? "").trim();
  } catch (error) {
    console.error("[sync] 读取数据库同步配置失败，回退环境变量:", error);
  }
  if (!url) url = (process.env.SYNC_REMOTE_URL ?? "").trim().replace(/\/+$/, "");
  if (!secret) secret = (process.env.SYNC_REMOTE_SECRET ?? "").trim();
  return { baseUrl: url.replace(/\/+$/, ""), secret };
}

export async function joinRequestSyncConfigured(): Promise<boolean> {
  const { baseUrl, secret } = await resolveRemoteSyncConfig();
  return !!baseUrl && !!secret;
}

export interface JoinRequestSyncResult {
  ok: boolean;
  imported: number;
  fetched: number;
  message: string;
}

type SyncPayload = {
  ok?: boolean;
  error?: string;
  requests?: Record<string, unknown>[];
  next_since?: string;
  has_more?: boolean;
};

export async function syncRemoteJoinRequests(): Promise<JoinRequestSyncResult> {
  const { baseUrl, secret } = await resolveRemoteSyncConfig();
  if (!baseUrl || !secret) {
    return { ok: false, imported: 0, fetched: 0, message: "同步未配置（后台「系统设置」填写线上地址与共享密钥）, 跳过同步" };
  }
  let since = (await getAppSetting(SINCE_KEY)) ?? "1970-01-01T00:00:00.000Z";
  let fetched = 0;
  let imported = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await fetch(
      `${baseUrl}/api/v1/sync/join-requests?since=${encodeURIComponent(since)}`,
      { headers: signHeaders(secret), signal: AbortSignal.timeout(30000) },
    );
    const text = await response.text();
    let payload: SyncPayload | null = null;
    try {
      payload = text.trim() ? (JSON.parse(text) as SyncPayload) : null;
    } catch {
      payload = null;
    }
    if (!response.ok || !payload || payload.ok !== true || !Array.isArray(payload.requests)) {
      throw new Error(`远端返回异常 (HTTP ${response.status}): ${text.slice(0, 200)}`);
    }
    const requests: Record<string, unknown>[] = payload.requests;
    fetched += requests.length;
    for (const row of requests) {
      const result = await executeRun(
        `INSERT INTO join_requests
           (user_id, chat_id, username, first_name, verification_token, status,
            request_time, verification_completed, admin_id, processed_time, request_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(verification_token) DO NOTHING`,
        [
          row.user_id === null || row.user_id === undefined ? null : Number(row.user_id),
          row.chat_id === null || row.chat_id === undefined ? null : Number(row.chat_id),
          row.username === null || row.username === undefined ? null : String(row.username),
          row.first_name === null || row.first_name === undefined ? null : String(row.first_name),
          String(row.verification_token ?? ""),
          String(row.status ?? "pending"),
          String(row.request_time ?? new Date().toISOString()),
          Number(row.verification_completed ?? 0),
          row.admin_id === null || row.admin_id === undefined ? null : Number(row.admin_id),
          row.processed_time === null || row.processed_time === undefined ? null : String(row.processed_time),
          row.request_type === null || row.request_type === undefined ? null : String(row.request_type),
        ],
      );
      imported += result.changes;
    }
    if (payload.next_since) {
      since = String(payload.next_since);
      await setAppSetting(SINCE_KEY, since);
    }
    if (!payload.has_more || requests.length === 0) break;
  }

  return {
    ok: true,
    imported,
    fetched,
    message: `同步完成: 拉取 ${fetched} 条, 本地新增 ${imported} 条 (其余为已存在记录)`,
  };
}
