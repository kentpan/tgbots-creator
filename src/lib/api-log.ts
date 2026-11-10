/**
 * 统一 API 日志（v2.2.5，server-only）
 *
 * 全站主要 API 调用的唯一落库点（api_logs 表，Node SQLite / Cloudflare D1 通用）：
 * - webhook  ：入站 Telegram Webhook 请求（POST /api/telegram/webhook/**）
 * - tgapi    ：TGAPI 申请 my.telegram.org 四步网络管道（传参 → 返回原始数据）
 * - deploy   ：一键部署动作（restartMenuBot / setWebhook / deleteWebhook 语义结果）
 * - bot-api  ：出站 api.telegram.org Bot API 调用（统一传输层钩子，排除 getUpdates 长轮询）
 *
 * 设计约束：
 * - fire-and-forget：logApi() 绝不阻塞/绝不影响主流程，内部所有异常仅 console 记录
 * - 总开关：app_settings "api.logs_enabled"（缺省开启；设为 "false" 关闭）
 * - 容量上限：keepLatestApiLogs() 按行数封顶（默认 5000），由 tasks.ts 清理循环周期调用
 */

import { executeRun, queryAll, queryOne } from "@/database/client";
import { cachedJson, getKv } from "@/database/bindings";
import { getCachedAppSettings } from "@/database/operations";

export type ApiLogCategory = "webhook" | "tgapi" | "deploy" | "bot-api";

export const API_LOG_CATEGORIES: ApiLogCategory[] = ["webhook", "tgapi", "deploy", "bot-api"];

export const API_LOG_CATEGORY_LABELS: Record<ApiLogCategory, string> = {
  webhook: "Webhook 请求",
  tgapi: "TGAPI 申请",
  deploy: "一键部署",
  "bot-api": "Bot API 调用",
};

/** 请求/响应原文落库截断上限（超出截断并标注，避免单行膨胀） */
const MAX_PAYLOAD_CHARS = 16 * 1024;

export const API_LOGS_ENABLED_SETTING_KEY = "api.logs_enabled";
/** api_logs 行数上限（容量封顶，防止无限增长） */
export const API_LOGS_MAX_ROWS = 5000;
/** 统计结果缓存 key（v2.2.6 D1 限额优化：全表聚合 ×4 的统计随清理/清空主动失效） */
export const API_LOGS_STATS_CACHE_KEY = "api-log:stats";
/** 统计缓存 5 分钟（看板容忍延迟，换取消除每次进页面的全表扫描） */
const STATS_CACHE_TTL_SECONDS = 300;

export interface ApiLogInput {
  category: ApiLogCategory;
  /** 关联机器人（webhook botId / 部署 botId；TGAPI 申请链路为申请机器人 id 或空） */
  botId?: string | null;
  /** 机器人用户名/标题快照（列表页直接可读，不必反查 bots 表） */
  botLabel?: string | null;
  /** 端点/步骤名：如 send_password、setWebhook、message、deploy */
  method: string;
  ok: boolean;
  /** HTTP 状态码（有则记） */
  statusCode?: number | null;
  /** 请求传参（原始） */
  requestPayload?: string | null;
  /** 返回结果原始数据 */
  responseBody?: string | null;
  /** 失败原因摘要 */
  error?: string | null;
  durationMs?: number | null;
}

// ---------------------------------------------------------------------------
// 建表（幂等，进程内 memo；Node SQLite 与 D1 同一 DDL）
// ---------------------------------------------------------------------------

const globalForApiLog = globalThis as unknown as { tguardApiLogsTableReady?: Promise<void> };

export function ensureApiLogsTable(): Promise<void> {
  if (!globalForApiLog.tguardApiLogsTableReady) {
    globalForApiLog.tguardApiLogsTableReady = (async () => {
      await executeRun(`CREATE TABLE IF NOT EXISTS "api_logs" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "category" TEXT NOT NULL,
        "bot_id" TEXT,
        "bot_label" TEXT,
        "method" TEXT NOT NULL DEFAULT '',
        "ok" INTEGER NOT NULL DEFAULT 1,
        "status_code" INTEGER,
        "request_payload" TEXT,
        "response_body" TEXT,
        "error" TEXT,
        "duration_ms" INTEGER,
        "created_time" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      await executeRun(`CREATE INDEX IF NOT EXISTS "api_logs_created_idx" ON "api_logs" ("created_time")`);
      await executeRun(`CREATE INDEX IF NOT EXISTS "api_logs_category_idx" ON "api_logs" ("category")`);
    })().catch((error) => {
      // 建表失败：重置 memo，下次调用重试（绝不永久吞错）
      globalForApiLog.tguardApiLogsTableReady = undefined;
      throw error;
    });
  }
  return globalForApiLog.tguardApiLogsTableReady;
}

/** 截断超长原文并标注省略 */
function truncatePayload(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  if (text.length <= MAX_PAYLOAD_CHARS) return text;
  return `${text.slice(0, MAX_PAYLOAD_CHARS)}…（截断，原文 ${text.length} 字符）`;
}

/** 日志开关（api.logs_enabled，缺省开启；读取失败按开启处理，绝不因日志配置阻断主流程） */
async function apiLogsEnabled(): Promise<boolean> {
  try {
    const stored = await getCachedAppSettings();
    return stored[API_LOGS_ENABLED_SETTING_KEY] !== "false";
  } catch {
    return true;
  }
}

/** 落库一条 API 日志（内部函数；所有异常仅 console 记录） */
async function insertApiLog(input: ApiLogInput): Promise<void> {
  if (!(await apiLogsEnabled())) return;
  await ensureApiLogsTable();
  await executeRun(
    `INSERT INTO "api_logs"
      ("category", "bot_id", "bot_label", "method", "ok", "status_code", "request_payload", "response_body", "error", "duration_ms")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.category,
      input.botId ?? null,
      input.botLabel ?? null,
      input.method ?? "",
      input.ok ? 1 : 0,
      input.statusCode ?? null,
      truncatePayload(input.requestPayload),
      truncatePayload(input.responseBody),
      input.error ? input.error.slice(0, 2000) : null,
      typeof input.durationMs === "number" ? Math.round(input.durationMs) : null,
    ],
  );
}

/**
 * fire-and-forget 记录一条 API 日志：绝不 throw、绝不 await（调用方零开销）。
 * 失败仅 console.warn（含类别与方法，便于定位日志自身问题）。
 */
export function logApi(input: ApiLogInput): void {
  void insertApiLog(input).catch((error: unknown) => {
    console.warn(
      `[api-log] 写入 ${input.category}/${input.method} 日志失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

// ---------------------------------------------------------------------------
// 查询（管理后台 API 日志页）
// ---------------------------------------------------------------------------

export interface ApiLogRow extends Record<string, unknown> {
  id: number;
  category: string;
  bot_id: string | null;
  bot_label: string | null;
  method: string;
  ok: number;
  status_code: number | null;
  request_payload: string | null;
  response_body: string | null;
  error: string | null;
  duration_ms: number | null;
  created_time: string;
}

export interface ApiLogListFilters {
  category?: string;
  ok?: "all" | "success" | "fail";
  q?: string;
  page: number;
  pageSize: number;
}

export async function listApiLogs(filters: ApiLogListFilters): Promise<{ rows: ApiLogRow[]; total: number }> {
  await ensureApiLogsTable();
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filters.category && API_LOG_CATEGORIES.includes(filters.category as ApiLogCategory)) {
    where.push(`"category" = ?`);
    params.push(filters.category);
  }
  if (filters.ok === "success") where.push(`"ok" = 1`);
  if (filters.ok === "fail") where.push(`"ok" = 0`);
  if (filters.q?.trim()) {
    const like = `%${filters.q.trim()}%`;
    where.push(`("method" LIKE ? OR "bot_label" LIKE ? OR "bot_id" LIKE ? OR "error" LIKE ? OR "request_payload" LIKE ?)`);
    params.push(like, like, like, like, like);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const totalRow = await queryOne<{ total: number }>(
    `SELECT COUNT(*) AS total FROM "api_logs" ${whereSql}`,
    params,
  );
  const pageSize = Math.min(Math.max(filters.pageSize, 10), 200);
  const page = Math.max(filters.page, 1);
  // v2.2.6 D1 限额优化：列表不再拖 request_payload/response_body 大字段（单条最大 16KB×2）——
  // payload 仅在详情弹窗按需单行读取（getApiLogDetail），列表行字段置 null 保持接口形状兼容
  const rows = await queryAll<ApiLogRow>(
    `SELECT "id", "category", "bot_id", "bot_label", "method", "ok", "status_code",
            "error", "duration_ms", "created_time",
            NULL AS "request_payload", NULL AS "response_body"
     FROM "api_logs" ${whereSql} ORDER BY "id" DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  return { rows, total: totalRow?.total ?? 0 };
}

/** 单条日志详情（v2.2.6 D1 限额优化：payload 大字段按需单行读取，1 行配额） */
export async function getApiLogDetail(id: number): Promise<ApiLogRow | null> {
  await ensureApiLogsTable();
  return (await queryOne<ApiLogRow>(`SELECT * FROM "api_logs" WHERE "id" = ?`, [id])) ?? null;
}

export interface ApiLogStats {
  summary: {
    total: number;
    last24h: number;
    last24hFail: number;
    successRate: number;
    avgDurationMs: number;
  };
  byCategory: { category: string; total: number; fail: number }[];
  /** 最近 24 小时按小时聚合（缺省小时补零，键为 MM-DD HH:00） */
  byHour: { hour: string; webhook: number; tgapi: number; deploy: number; "bot-api": number }[];
  topMethods: { method: string; total: number; fail: number }[];
  recentErrors: {
    id: number;
    category: string;
    method: string;
    bot_label: string | null;
    error: string | null;
    created_time: string;
  }[];
}

export async function getApiLogStats(): Promise<ApiLogStats> {
  // v2.2.6 D1 限额优化：统计含 4 个全表聚合（COUNT/SUM/GROUP BY ×2/24h 过滤）+ 错误抽样，
  // 5000 行封顶下每次进页面可扫 1-2 万行。结果缓存 5 分钟（进程内 memo + KV），
  // 清空/封顶清理时主动失效（clearApiLogs / keepLatestApiLogs），绝不展示已失效数据。
  return cachedJson<ApiLogStats>(API_LOGS_STATS_CACHE_KEY, STATS_CACHE_TTL_SECONDS, async () => {
    return getApiLogStatsUncached();
  });
}

async function getApiLogStatsUncached(): Promise<ApiLogStats> {
  await ensureApiLogsTable();
  const [totalRow, recentRow, byCategory, byMethodRaw, byHourRaw, recentErrors] = await Promise.all([
    queryOne<{ total: number; ok_count: number; avg_ms: number }>(
      `SELECT COUNT(*) AS total, COALESCE(SUM("ok"), 0) AS ok_count, AVG("duration_ms") AS avg_ms FROM "api_logs"`,
    ),
    queryOne<{ last24h: number; last24h_fail: number }>(
      `SELECT COUNT(*) AS last24h, COALESCE(SUM(CASE WHEN "ok" = 0 THEN 1 ELSE 0 END), 0) AS last24h_fail
       FROM "api_logs" WHERE "created_time" >= datetime('now', '-24 hours')`,
    ),
    queryAll<{ category: string; total: number; fail: number }>(
      `SELECT "category", COUNT(*) AS total, COALESCE(SUM(CASE WHEN "ok" = 0 THEN 1 ELSE 0 END), 0) AS fail
       FROM "api_logs" GROUP BY "category"`,
    ),
    queryAll<{ method: string; total: number; fail: number }>(
      `SELECT "method", COUNT(*) AS total, COALESCE(SUM(CASE WHEN "ok" = 0 THEN 1 ELSE 0 END), 0) AS fail
       FROM "api_logs" GROUP BY "method" ORDER BY total DESC LIMIT 8`,
    ),
    queryAll<{ bucket: string; category: string; total: number }>(
      `SELECT strftime('%m-%d %H:00', "created_time") AS bucket, "category", COUNT(*) AS total
       FROM "api_logs" WHERE "created_time" >= datetime('now', '-24 hours')
       GROUP BY bucket, "category"`,
    ),
    queryAll<ApiLogStats["recentErrors"][number]>(
      `SELECT "id", "category", "method", "bot_label", "error", "created_time"
       FROM "api_logs" WHERE "ok" = 0 ORDER BY "id" DESC LIMIT 6`,
    ),
  ]);

  // 24 小时桶补零（小时键为服务器 UTC 时间口径 —— created_time 由 SQLite CURRENT_TIMESTAMP 写入）
  const hourKeys: string[] = [];
  const now = new Date();
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 60 * 60 * 1000);
    const mm = `${d.getUTCMonth() + 1}`.padStart(2, "0");
    const dd = `${d.getUTCDate()}`.padStart(2, "0");
    const hh = `${d.getUTCHours()}`.padStart(2, "0");
    hourKeys.push(`${mm}-${dd} ${hh}:00`);
  }
  const byHourMap = new Map<string, ApiLogStats["byHour"][number]>();
  for (const key of hourKeys) {
    byHourMap.set(key, { hour: key, webhook: 0, tgapi: 0, deploy: 0, "bot-api": 0 });
  }
  for (const row of byHourRaw) {
    const bucket = byHourMap.get(row.bucket);
    if (bucket && (row.category === "webhook" || row.category === "tgapi" || row.category === "deploy" || row.category === "bot-api")) {
      bucket[row.category] = row.total;
    }
  }

  const total = totalRow?.total ?? 0;
  const okCount = totalRow?.ok_count ?? 0;
  return {
    summary: {
      total,
      last24h: recentRow?.last24h ?? 0,
      last24hFail: recentRow?.last24h_fail ?? 0,
      successRate: total > 0 ? Math.round((okCount / total) * 1000) / 10 : 100,
      avgDurationMs: Math.round(totalRow?.avg_ms ?? 0),
    },
    byCategory,
    byHour: hourKeys.map((key) => byHourMap.get(key)!),
    topMethods: byMethodRaw,
    recentErrors,
  };
}

/** 清空全部 API 日志（管理端「清空日志」动作） */
export async function clearApiLogs(): Promise<number> {
  await ensureApiLogsTable();
  const before = await queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM "api_logs"`);
  await executeRun(`DELETE FROM "api_logs"`);
  // AUTOINCREMENT 序列归位（从 1 重新编号，列表 id 保持直观）
  await executeRun(`DELETE FROM "sqlite_sequence" WHERE "name" = 'api_logs'`).catch(() => {
    /* D1/无 sqlite_sequence 时忽略 */
  });
  // v2.2.6：统计缓存主动失效（5 分钟窗口内不再展示已清空数据的旧统计）
  await getKv()
    .delete(API_LOGS_STATS_CACHE_KEY)
    .catch((error: unknown) => {
      console.warn(`[api-log] 清空日志后删除统计缓存失败: ${error instanceof Error ? error.message : String(error)}`);
    });
  return before?.total ?? 0;
}

/** 容量封顶：仅保留最新 API_LOGS_MAX_ROWS 行（tasks.ts 清理循环周期调用） */
export async function keepLatestApiLogs(maxRows: number = API_LOGS_MAX_ROWS): Promise<number> {
  await ensureApiLogsTable();
  // v2.2.6 D1 限额优化：旧实现 NOT IN (SELECT ... ORDER BY id DESC LIMIT ?) 需全表扫描
  // 两遍（子查询 + 外层 WHERE 逐行比对）；改为先取边界 id（主键索引 LIMIT OFFSET 1 行）
  // 再按主键范围删除，扫描行数从「全表×2」降为「maxRows×1 + 删除行数」。
  const boundary = await queryOne<{ id: number }>(
    `SELECT "id" FROM "api_logs" ORDER BY "id" DESC LIMIT 1 OFFSET ?`,
    [maxRows],
  );
  if (!boundary) return 0;
  const result = await executeRun(`DELETE FROM "api_logs" WHERE "id" < ?`, [boundary.id]);
  if (result.changes > 0) {
    // 删除后统计口径变化，主动失效统计缓存
    await getKv()
      .delete(API_LOGS_STATS_CACHE_KEY)
      .catch((error: unknown) => {
        console.warn(`[api-log] 容量封顶后删除统计缓存失败: ${error instanceof Error ? error.message : String(error)}`);
      });
  }
  return result.changes;
}

/** 请求体序列化（日志用 best-effort：字符串/URLSearchParams 直取；FormData 逐项展开；其余类型标注） */
export function serializeLogRequestBody(body: unknown): string | null {
  if (body === null || body === undefined) return null;
  try {
    if (typeof body === "string") return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      const parts: string[] = [];
      for (const [key, value] of body.entries()) {
        parts.push(`${key}=${typeof value === "string" ? value : `<file:${value.name}>`}`);
      }
      return parts.join("&");
    }
    return String(body);
  } catch {
    return `<unserializable:${typeof body}>`;
  }
}
