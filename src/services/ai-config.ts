import { executeRun, queryAll, queryOne } from "@/database/client";
import { invalidateCache } from "@/database/bindings";

/**
 * AI 模型配置服务（v1.1.0）
 *
 * - ai_providers：多 AI 提供方（OpenAI 兼容协议：/chat/completions + /models）
 * - ai_usage_logs：统一调用日志（供「调用统计」图表聚合）
 * - 接口限速：滑动窗口（如 60 次 / 60s），按 provider 维度内存计数
 *
 * 模型选择语义：
 * - selected_model = "auto"：自动选择（使用该 provider 拉取到的第一个可用模型）
 * - selected_model = 具体模型名：始终使用指定模型
 * - is_default = true：其他功能（客服机器人等）未显式指定 provider 时使用
 */

export interface AiProviderRow {
  id: bigint;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  selectedModel: string;
  rateLimitEnabled: boolean;
  rateLimitMax: number;
  rateLimitWindow: number;
  isDefault: boolean;
  enabled: boolean;
  remark: string;
  createdTime: string;
  updatedTime: string;
}

const AI_PROVIDERS_CACHE_KEY = "ai:providers:v1";

function toDateText(value: unknown): string {
  if (typeof value === "string") return value;
  return "";
}

function parseModels(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw ?? "[]")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function mapProvider(row: Record<string, unknown>): AiProviderRow {
  return {
    id: BigInt(row.id as number),
    name: String(row.name ?? ""),
    baseUrl: String(row.base_url ?? ""),
    apiKey: String(row.api_key ?? ""),
    models: parseModels(row.models_json),
    selectedModel: String(row.selected_model ?? "auto"),
    rateLimitEnabled: Number(row.rate_limit_enabled ?? 0) === 1,
    rateLimitMax: Number(row.rate_limit_max ?? 60),
    rateLimitWindow: Number(row.rate_limit_window ?? 60),
    isDefault: Number(row.is_default ?? 0) === 1,
    enabled: Number(row.enabled ?? 1) === 1,
    remark: String(row.remark ?? ""),
    createdTime: toDateText(row.created_time),
    updatedTime: toDateText(row.updated_time),
  };
}

/** 序列化给前端（API Key 打码：仅展示末 4 位，编辑留空 = 不修改） */
export function serializeProvider(row: AiProviderRow, maskKey = true): Record<string, unknown> {
  const key = row.apiKey;
  const masked = key.length > 8 ? `${key.slice(0, 4)}****${key.slice(-4)}` : key ? "****" : "";
  return {
    id: String(row.id),
    name: row.name,
    base_url: row.baseUrl,
    api_key_masked: maskKey ? masked : key,
    has_api_key: key.length > 0,
    models: row.models,
    selected_model: row.selectedModel,
    rate_limit_enabled: row.rateLimitEnabled,
    rate_limit_max: row.rateLimitMax,
    rate_limit_window: row.rateLimitWindow,
    is_default: row.isDefault,
    enabled: row.enabled,
    remark: row.remark,
    created_time: row.createdTime,
    updated_time: row.updatedTime,
  };
}

export async function listAiProviders(options?: {
  page?: number;
  pageSize?: number;
  keyword?: string;
}): Promise<{ rows: AiProviderRow[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, Math.floor(options?.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(options?.pageSize ?? 10)));
  const keyword = (options?.keyword ?? "").trim();

  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (keyword) {
    conditions.push(`(name LIKE ? OR base_url LIKE ? OR remark LIKE ?)`);
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const totalRow = await queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM ai_providers ${where}`, params);
  const rows = await queryAll<Record<string, unknown>>(
    `SELECT * FROM ai_providers ${where} ORDER BY is_default DESC, id ASC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  return {
    rows: rows.map(mapProvider),
    total: Number(totalRow?.total ?? 0),
    page,
    pageSize,
  };
}

export async function getAiProvider(id: bigint): Promise<AiProviderRow | null> {
  const row = await queryOne<Record<string, unknown>>(`SELECT * FROM ai_providers WHERE id = ?`, [Number(id)]);
  return row ? mapProvider(row) : null;
}

export async function listEnabledAiProviders(): Promise<AiProviderRow[]> {
  const rows = await queryAll<Record<string, unknown>>(`SELECT * FROM ai_providers WHERE enabled = 1 ORDER BY is_default DESC, id ASC`);
  return rows.map(mapProvider);
}

export async function resolveDefaultAiProvider(): Promise<AiProviderRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM ai_providers WHERE enabled = 1 AND is_default = 1 ORDER BY id ASC LIMIT 1`,
  );
  if (row) return mapProvider(row);
  // 无显式默认时回退第一个启用的 provider
  const fallback = await queryOne<Record<string, unknown>>(
    `SELECT * FROM ai_providers WHERE enabled = 1 ORDER BY id ASC LIMIT 1`,
  );
  return fallback ? mapProvider(fallback) : null;
}

export interface AiProviderUpsertInput {
  name: string;
  baseUrl: string;
  apiKey?: string;
  selectedModel?: string;
  rateLimitEnabled?: boolean;
  rateLimitMax?: number;
  rateLimitWindow?: number;
  isDefault?: boolean;
  enabled?: boolean;
  remark?: string;
}

function normalizeBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  // 允许用户直接粘贴完整 endpoint：剥离固定后缀，统一存储到版本根（…/v1）
  url = url.replace(/\/chat\/completions$/i, "").replace(/\/models$/i, "");
  return url;
}

export async function createAiProvider(input: AiProviderUpsertInput): Promise<AiProviderRow | null> {
  const now = new Date().toISOString();
  const result = await executeRun(
    `INSERT INTO ai_providers (name, base_url, api_key, models_json, selected_model, rate_limit_enabled, rate_limit_max, rate_limit_window, is_default, enabled, remark, created_time, updated_time)
     VALUES (?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.name.trim(),
      normalizeBaseUrl(input.baseUrl),
      (input.apiKey ?? "").trim(),
      (input.selectedModel ?? "auto").trim() || "auto",
      input.rateLimitEnabled ? 1 : 0,
      Math.max(1, Math.floor(input.rateLimitMax ?? 60)),
      Math.max(1, Math.floor(input.rateLimitWindow ?? 60)),
      input.isDefault ? 1 : 0,
      input.enabled === false ? 0 : 1,
      (input.remark ?? "").trim(),
      now,
      now,
    ],
  );
  if (input.isDefault) await promoteDefaultProvider(BigInt(result.lastInsertRowid));
  await invalidateCache(AI_PROVIDERS_CACHE_KEY);
  return getAiProvider(BigInt(result.lastInsertRowid));
}

export async function updateAiProvider(id: bigint, input: AiProviderUpsertInput): Promise<AiProviderRow | null> {
  const existing = await getAiProvider(id);
  if (!existing) return null;
  const now = new Date().toISOString();
  await executeRun(
    `UPDATE ai_providers SET name = ?, base_url = ?, api_key = ?, selected_model = ?, rate_limit_enabled = ?, rate_limit_max = ?, rate_limit_window = ?, is_default = ?, enabled = ?, remark = ?, updated_time = ? WHERE id = ?`,
    [
      input.name.trim(),
      normalizeBaseUrl(input.baseUrl),
      // 编辑时 API Key 留空 = 保持原值
      input.apiKey && input.apiKey.trim().length > 0 ? input.apiKey.trim() : existing.apiKey,
      (input.selectedModel ?? "auto").trim() || "auto",
      input.rateLimitEnabled ? 1 : 0,
      Math.max(1, Math.floor(input.rateLimitMax ?? 60)),
      Math.max(1, Math.floor(input.rateLimitWindow ?? 60)),
      input.isDefault ? 1 : 0,
      input.enabled === false ? 0 : 1,
      (input.remark ?? "").trim(),
      now,
      Number(id),
    ],
  );
  if (input.isDefault) await promoteDefaultProvider(id);
  await invalidateCache(AI_PROVIDERS_CACHE_KEY);
  return getAiProvider(id);
}

/** 设为唯一默认：先清空其他默认标记 */
export async function promoteDefaultProvider(id: bigint): Promise<void> {
  await executeRun(`UPDATE ai_providers SET is_default = 0 WHERE id != ?`, [Number(id)]);
  await executeRun(`UPDATE ai_providers SET is_default = 1, updated_time = ? WHERE id = ?`, [
    new Date().toISOString(),
    Number(id),
  ]);
  await invalidateCache(AI_PROVIDERS_CACHE_KEY);
}

export async function deleteAiProvider(id: bigint): Promise<boolean> {
  const result = await executeRun(`DELETE FROM ai_providers WHERE id = ?`, [Number(id)]);
  await invalidateCache(AI_PROVIDERS_CACHE_KEY);
  return result.changes > 0;
}

/** 保存拉取到的模型列表缓存 */
async function saveProviderModels(id: bigint, models: string[]): Promise<void> {
  await executeRun(`UPDATE ai_providers SET models_json = ?, updated_time = ? WHERE id = ?`, [
    JSON.stringify(models),
    new Date().toISOString(),
    Number(id),
  ]);
  await invalidateCache(AI_PROVIDERS_CACHE_KEY);
}

/** OpenAI 兼容模型列表响应（兼容 {data:[{id}]} 与 {models:[...]} 两种常见实现） */
interface ModelsResponseLike {
  data?: { id?: string; name?: string }[];
  models?: ({ id?: string; name?: string } | string)[];
}

function extractModelIds(payload: ModelsResponseLike): string[] {
  const ids = new Set<string>();
  for (const item of payload.data ?? []) {
    if (typeof item?.id === "string" && item.id.trim()) ids.add(item.id.trim());
    else if (typeof item?.name === "string" && item.name.trim()) ids.add(item.name.trim());
  }
  for (const item of payload.models ?? []) {
    if (typeof item === "string") {
      if (item.trim()) ids.add(item.trim());
    } else if (typeof item?.id === "string" && item.id.trim()) {
      ids.add(item.id.trim());
    } else if (typeof item?.name === "string" && item.name.trim()) {
      ids.add(item.name.trim());
    }
  }
  return Array.from(ids).sort((a, b) => a.localeCompare(b));
}

/** 直接用临时配置拉取模型列表（不落库；供新建/编辑对话框「探测」按钮使用） */
export async function fetchModelsDirect(
  baseUrlRaw: string,
  apiKey: string,
): Promise<{ ok: boolean; models: string[]; error?: string }> {
  const baseUrl = normalizeBaseUrl(baseUrlRaw);
  if (!/^https?:\/\//i.test(baseUrl)) {
    return { ok: false, models: [], error: "Base URL 必须以 http:// 或 https:// 开头" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
    const response = await fetch(`${baseUrl}/models`, { headers, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, models: [], error: `HTTP ${response.status}: ${text.slice(0, 300)}` };
    }
    let payload: ModelsResponseLike;
    try {
      payload = JSON.parse(text) as ModelsResponseLike;
    } catch {
      return { ok: false, models: [], error: "响应不是合法 JSON" };
    }
    const models = extractModelIds(payload);
    if (models.length === 0) {
      return { ok: false, models: [], error: "接口未返回任何模型（响应缺少 data/models 字段）" };
    }
    return { ok: true, models };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, models: [], error: message === "This operation was aborted" ? "请求超时（15s）" : message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从 provider 拉取支持的模型列表（GET {base_url}/models）并缓存到 models_json。
 * api_key 可为空（本地网关如 Ollama/LM Studio 常不需要鉴权）。
 */
export async function fetchProviderModels(id: bigint): Promise<{ ok: boolean; models: string[]; error?: string }> {
  const provider = await getAiProvider(id);
  if (!provider) return { ok: false, models: [], error: "AI 提供方不存在" };
  const baseUrl = normalizeBaseUrl(provider.baseUrl);
  if (!/^https?:\/\//i.test(baseUrl)) {
    return { ok: false, models: [], error: "Base URL 必须以 http:// 或 https:// 开头" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
    const response = await fetch(`${baseUrl}/models`, { headers, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, models: [], error: `HTTP ${response.status}: ${text.slice(0, 300)}` };
    }
    let payload: ModelsResponseLike;
    try {
      payload = JSON.parse(text) as ModelsResponseLike;
    } catch {
      return { ok: false, models: [], error: "响应不是合法 JSON（请确认 Base URL 指向 OpenAI 兼容接口）" };
    }
    const models = extractModelIds(payload);
    if (models.length === 0) {
      return { ok: false, models: [], error: "接口未返回任何模型（响应缺少 data/models 字段）" };
    }
    await saveProviderModels(id, models);
    return { ok: true, models };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, models: [], error: message === "This operation was aborted" ? "请求超时（15s）" : message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 解析 provider 的实际调用模型：
 * - selected_model 非 auto → 直接使用
 * - auto → 使用拉取列表的第一个模型；列表为空回退 gpt-4o-mini（占位，调用方可在请求时覆盖）
 */
export function resolveAiModel(provider: Pick<AiProviderRow, "selectedModel" | "models">): string {
  const selected = provider.selectedModel.trim();
  if (selected && selected !== "auto") return selected;
  return provider.models[0] ?? "gpt-4o-mini";
}

// ---------------------------------------------------------------------------
// 接口限速：滑动窗口（内存计数，按 provider 维度）
// ---------------------------------------------------------------------------

interface RateWindow {
  hits: number[];
}

const globalForRate = globalThis as unknown as { tguardAiRateWindows?: Map<number, RateWindow> };

function rateWindows(): Map<number, RateWindow> {
  if (!globalForRate.tguardAiRateWindows) {
    globalForRate.tguardAiRateWindows = new Map();
  }
  return globalForRate.tguardAiRateWindows;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  windowSeconds: number;
  remaining: number;
  retryAfterMs: number;
}

/**
 * 滑动窗口限速检查（不消费配额；实际调用前调用，成功发起请求时由调用方 markAiHit 计数）。
 * 未启用限速的 provider 恒允许。
 */
export function checkAiRateLimit(provider: Pick<AiProviderRow, "id" | "rateLimitEnabled" | "rateLimitMax" | "rateLimitWindow">): RateLimitDecision {
  const decision: RateLimitDecision = {
    allowed: true,
    limit: provider.rateLimitMax,
    windowSeconds: provider.rateLimitWindow,
    remaining: provider.rateLimitMax,
    retryAfterMs: 0,
  };
  if (!provider.rateLimitEnabled) return decision;
  const now = Date.now();
  const windowMs = provider.rateLimitWindow * 1000;
  const entry = rateWindows().get(Number(provider.id)) ?? { hits: [] };
  entry.hits = entry.hits.filter((time) => now - time < windowMs);
  if (entry.hits.length >= provider.rateLimitMax) {
    const oldest = entry.hits[0] ?? now;
    decision.allowed = false;
    decision.remaining = 0;
    decision.retryAfterMs = Math.max(0, windowMs - (now - oldest));
  } else {
    decision.remaining = provider.rateLimitMax - entry.hits.length;
  }
  rateWindows().set(Number(provider.id), entry);
  return decision;
}

/** 记录一次实际调用（成功发起 HTTP 请求时） */
export function markAiHit(providerId: bigint): void {
  const entry = rateWindows().get(Number(providerId)) ?? { hits: [] };
  entry.hits.push(Date.now());
  rateWindows().set(Number(providerId), entry);
}

/** 重置 provider 的限速窗口（编辑配置后调用，避免旧窗口误拦） */
export function resetAiRateWindow(providerId: bigint): void {
  rateWindows().delete(Number(providerId));
}

// ---------------------------------------------------------------------------
// 调用统计（chart.js 数据源）
// ---------------------------------------------------------------------------

export interface AiUsageSummary {
  total: number;
  success: number;
  failed: number;
  successRate: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  avgDurationMs: number;
}

export interface AiUsageStats {
  summary: AiUsageSummary;
  byDay: { day: string; total: number; success: number; failed: number; tokens: number }[];
  byModel: { model: string; total: number; tokens: number }[];
  byProvider: { provider: string; total: number; tokens: number }[];
  byScene: { scene: string; total: number; tokens: number }[];
  recentErrors: { model: string; error: string; created_time: string }[];
}

export async function getAiUsageStats(days = 7): Promise<AiUsageStats> {
  const days0 = Math.min(90, Math.max(1, Math.floor(days)));
  const rows = await queryAll<Record<string, unknown>>(
    `SELECT provider_name, model, scene, prompt_tokens, completion_tokens, total_tokens, duration_ms, success, error, created_time
     FROM ai_usage_logs
     WHERE created_time >= datetime('now', '-' || ? || ' days')
     ORDER BY created_time DESC
     LIMIT 5000`,
    [days0],
  );

  const summary: AiUsageSummary = {
    total: rows.length,
    success: 0,
    failed: 0,
    successRate: 0,
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    avgDurationMs: 0,
  };
  const dayMap = new Map<string, { total: number; success: number; failed: number; tokens: number }>();
  const modelMap = new Map<string, { total: number; tokens: number }>();
  const providerMap = new Map<string, { total: number; tokens: number }>();
  const sceneMap = new Map<string, { total: number; tokens: number }>();
  const recentErrors: { model: string; error: string; created_time: string }[] = [];
  let durationSum = 0;

  for (const row of rows) {
    const ok = Number(row.success ?? 0) === 1;
    const tokens = Number(row.total_tokens ?? 0);
    const duration = Number(row.duration_ms ?? 0);
    if (ok) summary.success += 1;
    else {
      summary.failed += 1;
      if (recentErrors.length < 20) {
        recentErrors.push({
          model: String(row.model ?? ""),
          error: String(row.error ?? "").slice(0, 200),
          created_time: String(row.created_time ?? ""),
        });
      }
    }
    summary.totalTokens += tokens;
    summary.promptTokens += Number(row.prompt_tokens ?? 0);
    summary.completionTokens += Number(row.completion_tokens ?? 0);
    durationSum += duration;

    const created = String(row.created_time ?? "");
    const day = created.slice(0, 10);
    const dayEntry = dayMap.get(day) ?? { total: 0, success: 0, failed: 0, tokens: 0 };
    dayEntry.total += 1;
    if (ok) dayEntry.success += 1;
    else dayEntry.failed += 1;
    dayEntry.tokens += tokens;
    dayMap.set(day, dayEntry);

    const model = String(row.model || "unknown");
    const modelEntry = modelMap.get(model) ?? { total: 0, tokens: 0 };
    modelEntry.total += 1;
    modelEntry.tokens += tokens;
    modelMap.set(model, modelEntry);

    const providerName = String(row.provider_name || "unknown");
    const providerEntry = providerMap.get(providerName) ?? { total: 0, tokens: 0 };
    providerEntry.total += 1;
    providerEntry.tokens += tokens;
    providerMap.set(providerName, providerEntry);

    const scene = String(row.scene || "chat");
    const sceneEntry = sceneMap.get(scene) ?? { total: 0, tokens: 0 };
    sceneEntry.total += 1;
    sceneEntry.tokens += tokens;
    sceneMap.set(scene, sceneEntry);
  }

  summary.successRate = summary.total > 0 ? Math.round((summary.success / summary.total) * 1000) / 10 : 0;
  summary.avgDurationMs = summary.total > 0 ? Math.round(durationSum / summary.total) : 0;

  // 补全空日期（近 N 天连续轴）
  const byDay: { day: string; total: number; success: number; failed: number; tokens: number }[] = [];
  const today = new Date();
  for (let offset = days0 - 1; offset >= 0; offset -= 1) {
    const date = new Date(today.getTime() - offset * 86400000);
    const day = date.toISOString().slice(0, 10);
    const entry = dayMap.get(day) ?? { total: 0, success: 0, failed: 0, tokens: 0 };
    byDay.push({ day, ...entry });
  }

  return {
    summary,
    byDay,
    byModel: Array.from(modelMap.entries())
      .map(([model, value]) => ({ model, ...value }))
      .sort((a, b) => b.total - a.total),
    byProvider: Array.from(providerMap.entries())
      .map(([provider, value]) => ({ provider, ...value }))
      .sort((a, b) => b.total - a.total),
    byScene: Array.from(sceneMap.entries())
      .map(([scene, value]) => ({ scene, ...value }))
      .sort((a, b) => b.total - a.total),
    recentErrors,
  };
}

// ---------------------------------------------------------------------------
// 统一调用日志
// ---------------------------------------------------------------------------

export async function recordAiUsage(input: {
  providerId?: bigint | null;
  providerName: string;
  model: string;
  scene: string;
  botId?: bigint | null;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  durationMs: number;
  success: boolean;
  error?: string | null;
}): Promise<void> {
  await executeRun(
    `INSERT INTO ai_usage_logs (provider_id, provider_name, model, scene, bot_id, prompt_tokens, completion_tokens, total_tokens, duration_ms, success, error, created_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.providerId != null ? Number(input.providerId) : null,
      input.providerName,
      input.model,
      input.scene,
      input.botId != null ? Number(input.botId) : null,
      Math.max(0, Math.floor(input.promptTokens ?? 0)),
      Math.max(0, Math.floor(input.completionTokens ?? 0)),
      Math.max(0, Math.floor(input.totalTokens ?? 0)),
      Math.max(0, Math.floor(input.durationMs)),
      input.success ? 1 : 0,
      input.error ? input.error.slice(0, 500) : null,
      new Date().toISOString(),
    ],
  ).catch((error) => {
    console.warn("Failed to record AI usage log:", error);
  });
}
