import { cachedJson } from "@/database/bindings";
import { getCachedAppSettings } from "@/database/operations";
import { SESSION_STORAGE_D1_KEYS } from "@/bot/session-storage";
import { probeCloudflareAccountId } from "@/lib/cloudflare-api";

/**
 * Dashboard 核心指标 —— D1 每日读写用量（v2.0.7，v2.1.3 重做真实获取链路）。
 *
 * 数据源：Cloudflare GraphQL Analytics API `d1AnalyticsAdaptiveGroups`
 * （与 Cloudflare Dashboard D1 页面同一数据集，按 UTC 日聚合）。
 *
 * v2.1.3 关键修复（用户要求「一定要使用注入到运行环境中的 CLOUDFLARE_API_TOKEN 真实获取」）：
 * 1. 修复 v2.0.7 起 GraphQL 变量类型写成小写 `string!`/`string` 的致命 bug ——
 *    GraphQL 类型区分大小写，Cloudflare 端直接报 "Unknown type 'string'"，
 *    卡片从上线起就一直显示 GraphQL 错误，从未真实出过数据；
 * 2. 凭据解析改为**运行环境注入的环境变量优先**：
 *    Token:   CLOUDFLARE_API_TOKEN > TG_D1_API_TOKEN > 管理后台已存配置
 *    Account: CLOUDFLARE_ACCOUNT_ID > TG_D1_ACCOUNT_ID > 管理后台已存配置
 *    库 ID:   D1_DATABASE_ID      > TG_D1_DATABASE_ID  > 管理后台已存配置
 *    CI 部署（pages-deploy.yml）会把部署 token/账号/库 ID 注入运行时 env
 *    （TG_D1_API_TOKEN 值 = 仓库 Secret CLOUDFLARE_API_TOKEN），因此线上
 *    无需任何手动配置即可真实出数；后台已存配置仅作兜底。
 * 3. D1_DATABASE_ID 可选（与用户参考脚本同语义）：留空 = 查询账户下所有数据库
 *    的合计用量（GraphQL 不传 databaseId 过滤）。
 *
 * 免费层每日限额（UTC 午夜重置）：
 * - 行读取：5,000,000 行/天
 * - 行写入：100,000 行/天
 *
 * 权限：API Token 需要 Account Analytics:Read（wrangler d1 insights 同一要求）；
 * 若注入的部署 Token 未含该权限，本服务返回明确错误提示，不影响页面其他模块。
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
  /** D1 指标查询凭据是否可用（运行环境注入或后台配置任一完整） */
  configured: boolean;
  /** 配置来源（env-cloudflare=运行环境 CLOUDFLARE_* 注入 / env-default=TG_D1_* 部署默认值 / stored=管理后台已保存 / none=缺失） */
  source: {
    accountId: D1ConfigSourceKind;
    databaseId: D1ConfigSourceKind;
    apiToken: D1ConfigSourceKind;
  } | null;
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
  /** true = 未指定库 ID，统计为账户下全部 D1 数据库合计 */
  accountWide: boolean;
  error?: string;
}

export type D1ConfigSourceKind = "env-cloudflare" | "env-default" | "stored" | "auto-probe" | "none";

function currentUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

// v2.1.3 修复：变量类型必须用 GraphQL 内建的 String!/String（旧实现写成小写
// `string!`，Cloudflare GraphQL 解析直接报 "Unknown type 'string'" 永远失败）。
const DAILY_USAGE_QUERY = `query D1DailyUsage($accountTag: String!, $start: Date!, $end: Date!, $databaseId: String) {
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

function envValue(name: string): string {
  return (process.env[name] ?? "").trim();
}

/**
 * D1 指标查询凭据解析（v2.1.3，运行环境注入优先）：
 * 1. CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / D1_DATABASE_ID（用户指定
 *    的运行环境注入名，OpenNext 会把 Pages env_vars 同步进 process.env）；
 * 2. TG_D1_API_TOKEN / TG_D1_ACCOUNT_ID / TG_D1_DATABASE_ID（CI pages-deploy.yml
 *    注入的部署默认值，值同上）；
 * 3. 管理后台「系统设置 → BOT 数据存储」已保存配置（兜底）。
 */
async function resolveMetricsD1Config(): Promise<{
  accountId: string;
  databaseId: string;
  apiToken: string;
  source: { accountId: D1ConfigSourceKind; databaseId: D1ConfigSourceKind; apiToken: D1ConfigSourceKind };
}> {
  let stored: Record<string, string> = {};
  try {
    stored = await getCachedAppSettings();
  } catch {
    stored = {};
  }
  const storedAccountId = (stored[SESSION_STORAGE_D1_KEYS.accountId] ?? "").trim();
  const storedDatabaseId = (stored[SESSION_STORAGE_D1_KEYS.databaseId] ?? "").trim();
  const storedApiToken = (stored[SESSION_STORAGE_D1_KEYS.apiToken] ?? "").trim();

  const databaseId = envValue("D1_DATABASE_ID") || envValue("TG_D1_DATABASE_ID") || storedDatabaseId;
  const apiToken = envValue("CLOUDFLARE_API_TOKEN") || envValue("TG_D1_API_TOKEN") || storedApiToken;

  // v2.2.6：账号 ID 运行时自动探测（pages-deploy.yml「Resolve Cloudflare account ID」
  // 步骤同源方式）。仅当配置了 Token 但三个来源（CLOUDFLARE_ACCOUNT_ID /
  // TG_D1_ACCOUNT_ID / 后台已存）都拿不到账号 ID 时才发起探测，
  // 探测结果进程内缓存 5 分钟（见 cloudflare-api.ts）；失败时抛出详细错误，不静默。
  const explicitAccountId = envValue("CLOUDFLARE_ACCOUNT_ID") || envValue("TG_D1_ACCOUNT_ID") || storedAccountId;
  let accountId = explicitAccountId;
  let accountIdProbed = false;
  if (!accountId && apiToken) {
    accountId = await probeCloudflareAccountId(apiToken);
    accountIdProbed = true;
  }

  const pick = (value: string, envCloudflare: string, envDefault: string, storedValue: string): D1ConfigSourceKind => {
    if (envCloudflare && value === envCloudflare.trim()) return "env-cloudflare";
    if (envDefault && value === envDefault.trim()) return "env-default";
    if (storedValue && value === storedValue.trim()) return "stored";
    return value ? "stored" : "none";
  };

  return {
    accountId,
    databaseId,
    apiToken,
    source: {
      accountId: accountIdProbed ? "auto-probe" : pick(accountId, envValue("CLOUDFLARE_ACCOUNT_ID"), envValue("TG_D1_ACCOUNT_ID"), storedAccountId),
      databaseId: pick(databaseId, envValue("D1_DATABASE_ID"), envValue("TG_D1_DATABASE_ID"), storedDatabaseId),
      apiToken: pick(apiToken, envValue("CLOUDFLARE_API_TOKEN"), envValue("TG_D1_API_TOKEN"), storedApiToken),
    },
  };
}

export async function getD1DailyUsage(): Promise<D1DailyUsage> {
  const dateUTC = currentUtcDate();
  const cacheKey = `d1-metrics:daily:${dateUTC}`;

  // v2.2.6：凭据解析（含账号 ID 自动探测）失败时错误完整进入 usage.error 返回
  // 前端展示（卡片红字），绝不静默、也绝不让 Dashboard 接口 500。
  let config: Awaited<ReturnType<typeof resolveMetricsD1Config>>;
  const limits = { rowsRead: D1_FREE_TIER_DAILY_LIMITS.rowsRead, rowsWritten: D1_FREE_TIER_DAILY_LIMITS.rowsWritten };
  try {
    config = await resolveMetricsD1Config();
  } catch (error) {
    return {
      ok: false,
      configured: true,
      source: null,
      dateUTC,
      rowsRead: 0,
      rowsWritten: 0,
      readQueries: 0,
      writeQueries: 0,
      limits,
      readPercent: 0,
      writePercent: 0,
      accountWide: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  // v2.1.3：databaseId 可选 —— 留空 = 账户下所有 D1 数据库合计（与参考脚本同语义）
  const configured = Boolean(config.accountId && config.apiToken);
  const accountWide = !config.databaseId;

  if (!configured) {
    return {
      ok: false,
      configured: false,
      source: config.source,
      dateUTC,
      rowsRead: 0,
      rowsWritten: 0,
      readQueries: 0,
      writeQueries: 0,
      limits,
      readPercent: 0,
      writePercent: 0,
      accountWide,
      error: "未获取到 D1 指标凭据：运行环境需注入 CLOUDFLARE_API_TOKEN（账号 ID 缺失时将自动探测），或在系统设置 → BOT 数据存储 / TG_D1_* 部署默认值中配置",
    };
  }

  // 缓存策略（v2.1.3）：
  // - 成功结果：cachedJson（KV + 进程内 memo，多 isolate 共享）缓存 5 分钟 ——
  //   Dashboard 每次刷新都打 Cloudflare API 会浪费配额，5 分钟聚合一次足够；
  // - 失败结果：**不写入主缓存**（loader 抛 sentinel 让 cachedJson 跳过 KV 写），
  //   仅 60s 进程内 memo 去重 —— 修好 Token 权限后点「刷新」最迟 60s 内即可出真数据，
  //   绝不出现「错误结果被缓存 5 分钟、修好配置还是旧报错」的坑。
  try {
    return await cachedJson<D1DailyUsage>(
      cacheKey,
      METRICS_CACHE_TTL_SECONDS,
      async () => {
        const usage = await fetchDailyUsage(config, dateUTC);
        if (!usage.ok) throw new D1MetricsFailure(usage);
        return usage;
      },
    );
  } catch (error) {
    if (error instanceof D1MetricsFailure) {
      // 失败结果 60s 进程内去重（不落 KV）：避免错误风暴连续打 Cloudflare API
      const now = Date.now();
      if (
        D1MetricsFailureMemo &&
        D1MetricsFailureMemo.key === cacheKey &&
        now - D1MetricsFailureMemo.at < METRICS_ERROR_CACHE_TTL_SECONDS * 1000
      ) {
        return D1MetricsFailureMemo.usage;
      }
      D1MetricsFailureMemo = { key: cacheKey, at: now, usage: error.usage };
      return error.usage;
    }
    // cachedJson 底层 KV 写失败等异常不阻塞指标返回
    return fetchDailyUsage(config, dateUTC);
  }
}

/** 失败结果 sentinel：让 cachedJson 跳过主缓存写入（失败只做短进程内去重） */
class D1MetricsFailure extends Error {
  constructor(public readonly usage: D1DailyUsage) {
    super(usage.error ?? "D1 metrics failure");
  }
}

let D1MetricsFailureMemo: { key: string; at: number; usage: D1DailyUsage } | null = null;

async function fetchDailyUsage(
  config: { accountId: string; databaseId: string; apiToken: string; source: { accountId: D1ConfigSourceKind; databaseId: D1ConfigSourceKind; apiToken: D1ConfigSourceKind } },
  dateUTC: string,
): Promise<D1DailyUsage> {
  const limits = { rowsRead: D1_FREE_TIER_DAILY_LIMITS.rowsRead, rowsWritten: D1_FREE_TIER_DAILY_LIMITS.rowsWritten };
  const accountWide = !config.databaseId;
  const failure = (error: string): D1DailyUsage => ({
    ok: false,
    configured: true,
    source: config.source,
    dateUTC,
    rowsRead: 0,
    rowsWritten: 0,
    readQueries: 0,
    writeQueries: 0,
    limits,
    readPercent: 0,
    writePercent: 0,
    accountWide,
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
          // 留空 = 账户级（不传过滤）；GraphQL 变量为 String 可空
          ...(config.databaseId ? { databaseId: config.databaseId } : {}),
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      if (response.status === 403 || response.status === 401) {
        return failure(
          "Cloudflare API 拒绝访问（HTTP 403）：注入运行环境的 API Token 需要 Account Analytics:Read 权限才能读取 D1 用量指标",
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
      source: config.source,
      dateUTC,
      rowsRead,
      rowsWritten,
      readQueries,
      writeQueries,
      limits,
      readPercent: percentClamped(rowsRead, limits.rowsRead),
      writePercent: percentClamped(rowsWritten, limits.rowsWritten),
      accountWide,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(message.includes("aborted") || message.includes("timeout")
      ? "Cloudflare API 请求超时（10s）"
      : `请求失败：${message}`);
  }
}
