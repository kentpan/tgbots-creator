import { cachedJson } from "@/database/bindings";
import { resolveD1RestConfig, type D1ConfigSource } from "@/bot/session-storage";

/**
 * Dashboard 核心指标 —— D1 每日读写用量（v2.0.7）。
 *
 * 数据源：Cloudflare GraphQL Analytics API `d1AnalyticsAdaptiveGroups`
 * （与 Cloudflare Dashboard D1 页面同一数据集，按 UTC 日聚合；指标保留 31 天）。
 *
 * 免费层每日限额（UTC 午夜重置）：
 * - 行读取：5,000,000 行/天
 * - 行写入：100,000 行/天
 *
 * 权限：API Token 需要 Account Analytics:Read（wrangler d1 insights 同一要求）；
 * 部署默认值（TG_D1_*，pages-deploy.yml 注入的 CLOUDFLARE_API_TOKEN）若未含该
 * 权限，本服务返回 forbidden 错误提示，不影响页面其他模块。
 *
 * 缓存：成功结果缓存 5 分钟（KV + 进程内 memo，多 isolate 共享），失败结果缓存
 * 60 秒 —— 避免每次刷新 Dashboard 都打 Cloudflare API。
 */

/** D1 免费层每日限额（行） */
export const D1_FREE_TIER_DAILY_LIMITS = {
  rowsRead: 5_000_000,
  rowsWritten: 100_000,
} as const;

/** 成功缓存 5 分钟；失败缓存 60 秒（避免错误风暴打爆 Cloudflare API） */
const METRICS_CACHE_TTL_SECONDS = 300;
const METRICS_ERROR_CACHE_TTL_SECONDS = 60;

export interface D1DailyUsage {
  ok: boolean;
  /** D1 REST 配置是否可用（存储设置或部署默认值任一完整） */
  configured: boolean;
  /** 配置来源（stored=管理后台已保存 / env-default=部署默认值） */
  source: D1ConfigSource | null;
  /** 统计窗口（UTC 日，YYYY-MM-DD —— 与 D1 限额重置周期一致） */
  dateUTC: string;
  rowsRead: number;
  rowsWritten: number;
  readQueries: number;
  writeQueries: number;
  limits: { rowsRead: number; rowsWritten: number };
  /** 占免费层限额的百分比（0-100，上限截断为 999 方便展示） */
  readPercent: number;
  writePercent: number;
  error?: string;
}

function currentUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

const DAILY_USAGE_QUERY = `query D1DailyUsage($accountTag: string!, $start: Date, $end: Date, $databaseId: string) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      d1AnalyticsAdaptiveGroups(
        limit: 10000
        filter: { date_geq: $start, date_leq: $end, databaseId: $databaseId }
        orderBy: [date_DESC]
      ) {
        sum {
          readQueries
          writeQueries
          rowsRead
          rowsWritten
        }
        dimensions {
          date
        }
      }
    }
  }
}`;

interface GraphQLGroupRow {
  sum?: {
    readQueries?: number | null;
    writeQueries?: number | null;
    rowsRead?: number | null;
    rowsWritten?: number | null;
  } | null;
  dimensions?: { date?: string | null } | null;
}

interface GraphQLResponse {
  data?: {
    viewer?: {
      accounts?: {
        d1AnalyticsAdaptiveGroups?: GraphQLGroupRow[] | null;
      }[] | null;
    };
  };
  errors?: { message?: string }[] | null;
}

function toNumber(value: number | string | null | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function percentClamped(value: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.min(999, Math.round((value / limit) * 1000) / 10);
}

export async function getD1DailyUsage(): Promise<D1DailyUsage> {
  const dateUTC = currentUtcDate();
  const cacheKey = `d1-metrics:daily:${dateUTC}`;

  const { config, source } = await resolveD1RestConfig();
  const configured = Boolean(config.accountId && config.databaseId && config.apiToken);
  const limits = { rowsRead: D1_FREE_TIER_DAILY_LIMITS.rowsRead, rowsWritten: D1_FREE_TIER_DAILY_LIMITS.rowsWritten };

  if (!configured) {
    return {
      ok: false,
      configured: false,
      source,
      dateUTC,
      rowsRead: 0,
      rowsWritten: 0,
      readQueries: 0,
      writeQueries: 0,
      limits,
      readPercent: 0,
      writePercent: 0,
      error: "未配置 D1（系统设置 → BOT 数据存储，或部署默认值未注入）",
    };
  }

  // 缓存走 cachedJson（KV + 进程内 memo，多 isolate 共享）——
  // Dashboard 每次刷新都打 Cloudflare API 会浪费配额，5 分钟聚合一次足够。
  try {
    return await cachedJson<D1DailyUsage>(cacheKey, METRICS_CACHE_TTL_SECONDS, async () => {
      return fetchDailyUsage(config, source, dateUTC);
    });
  } catch {
    // cachedJson 底层 KV 写失败等异常不阻塞指标返回
    return fetchDailyUsage(config, source, dateUTC);
  }
}

async function fetchDailyUsage(
  config: { accountId: string; databaseId: string; apiToken: string },
  source: D1ConfigSource,
  dateUTC: string,
): Promise<D1DailyUsage> {
  const limits = { rowsRead: D1_FREE_TIER_DAILY_LIMITS.rowsRead, rowsWritten: D1_FREE_TIER_DAILY_LIMITS.rowsWritten };
  const failure = (error: string): D1DailyUsage => ({
    ok: false,
    configured: true,
    source,
    dateUTC,
    rowsRead: 0,
    rowsWritten: 0,
    readQueries: 0,
    writeQueries: 0,
    limits,
    readPercent: 0,
    writePercent: 0,
    error,
  });

  try {
    const response = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: DAILY_USAGE_QUERY,
        variables: {
          accountTag: config.accountId,
          start: dateUTC,
          end: dateUTC,
          databaseId: config.databaseId,
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      if (response.status === 403 || response.status === 401) {
        return failure(
          "Cloudflare API 拒绝访问（HTTP 403）：Token 需要 Account Analytics:Read 权限才能读取 D1 用量指标",
        );
      }
      return failure(`Cloudflare API HTTP ${response.status}`);
    }

    const payload = (await response.json()) as GraphQLResponse;
    if (payload.errors && payload.errors.length > 0) {
      const first = payload.errors[0]?.message ?? "unknown GraphQL error";
      return failure(
        first.toLowerCase().includes("analytics")
          ? `GraphQL 权限不足：${first}（Token 需要 Account Analytics:Read）`
          : `GraphQL 错误：${first}`,
      );
    }

    const groups =
      payload.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? [];
    let rowsRead = 0;
    let rowsWritten = 0;
    let readQueries = 0;
    let writeQueries = 0;
    for (const group of groups) {
      rowsRead += toNumber(group.sum?.rowsRead);
      rowsWritten += toNumber(group.sum?.rowsWritten);
      readQueries += toNumber(group.sum?.readQueries);
      writeQueries += toNumber(group.sum?.writeQueries);
    }

    return {
      ok: true,
      configured: true,
      source,
      dateUTC,
      rowsRead,
      rowsWritten,
      readQueries,
      writeQueries,
      limits,
      readPercent: percentClamped(rowsRead, limits.rowsRead),
      writePercent: percentClamped(rowsWritten, limits.rowsWritten),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(message.includes("aborted") || message.includes("timeout")
      ? "Cloudflare API 请求超时（10s）"
      : `请求失败：${message}`);
  }
}
