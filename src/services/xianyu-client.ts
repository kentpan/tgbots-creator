/**
 * 闲鱼商品导入 / 模拟发货 的外部 API 客户端。
 *
 * 设计要点：
 * - 用户在「机器人测试」页面运行时配置 api url + Bearer apikey，本模块只负责调用与结果归一化；
 * - 响应解析极度宽容：兼容根数组、data.list / data.items / data.products / list / items / rows 等常见包装；
 * - 商品字段兼容 id/product_id/item_id/goods_id、title/name/goods_name、price/amount、pic/image/cover 等；
 * - 每次调用都产出完整的请求/响应日志（apikey 脱敏），供前端弹窗展示与 xianyu_delivery_logs 落库。
 */

export interface ExternalRequestLog {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface ExternalResponseLog {
  status: number;
  contentType: string | null;
  durationMs: number;
  bodyText: string;
}

export interface NormalizedProduct {
  externalId: string | null;
  title: string;
  price: string | null;
  description: string | null;
  imageUrl: string | null;
  raw: unknown;
}

export interface XianyuImportResult {
  ok: boolean;
  products: NormalizedProduct[];
  error?: string;
  request: ExternalRequestLog;
  response: ExternalResponseLog | null;
}

export interface XianyuDeliverResult {
  ok: boolean;
  code: string | null;
  message: string | null;
  error?: string;
  request: ExternalRequestLog;
  response: ExternalResponseLog | null;
}

const USER_AGENT = "TGuard-Simulator/1.0.8 (+https://tguard.local)";

export function maskApiKey(key: string): string {
  if (key.length <= 8) return `${key.slice(0, 2)}••••`;
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

function prettyJson(text: string, limit = 6000): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2).slice(0, limit);
  } catch {
    return text.slice(0, limit);
  }
}

function firstString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function extractArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== "object" || payload === null) return [];
  const record = payload as Record<string, unknown>;
  // 多账号分组结构（闲鱼开放接口）：groups[].items[] 拍平为商品数组，并附加店铺信息
  for (const key of ["groups", "group_list"]) {
    const value = record[key];
    if (Array.isArray(value)) return flattenGroupItems(value);
  }
  for (const key of ["list", "items", "products", "records", "rows", "goods", "result"]) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  const data = record.data;
  if (typeof data === "object" && data !== null) {
    if (Array.isArray(data)) return data;
    const dataRecord = data as Record<string, unknown>;
    for (const key of ["groups", "group_list"]) {
      const value = dataRecord[key];
      if (Array.isArray(value)) return flattenGroupItems(value);
    }
    for (const key of ["list", "items", "products", "records", "rows", "goods"]) {
      const value = dataRecord[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}

/** 把 groups[].items[] 拍平：每个商品附加所在店铺的 username/remark/cookie_id（不覆盖原有字段） */
function flattenGroupItems(groups: unknown[]): unknown[] {
  const items: unknown[] = [];
  for (const group of groups) {
    if (typeof group !== "object" || group === null) continue;
    const record = group as Record<string, unknown>;
    const groupItems = record.items;
    if (!Array.isArray(groupItems)) continue;
    const storeInfo: Record<string, unknown> = {
      store_username: record.username ?? null,
      store_remark: record.remark ?? null,
      store_cookie_id: record.cookie_id ?? null,
    };
    for (const item of groupItems) {
      if (typeof item === "object" && item !== null) {
        items.push({ ...storeInfo, ...(item as Record<string, unknown>) });
      } else {
        items.push(item);
      }
    }
  }
  return items;
}

function normalizeProduct(item: unknown): NormalizedProduct | null {
  if (typeof item === "string") {
    const text = item.trim();
    if (!text) return null;
    try {
      return normalizeProduct(JSON.parse(text));
    } catch {
      return { externalId: null, title: text, price: null, description: null, imageUrl: null, raw: item };
    }
  }
  if (typeof item !== "object" || item === null) return null;
  const record = item as Record<string, unknown>;
  const nested = typeof record.data === "object" && record.data !== null && !Array.isArray(record.data)
    ? (record.data as Record<string, unknown>)
    : {};
  const title =
    firstString(record, ["title", "item_title", "itemTitle", "name", "goods_name", "item_name", "product_name"]) ??
    firstString(nested, ["title", "item_title", "itemTitle", "name", "goods_name", "item_name", "product_name"]);
  if (!title) return null;
  return {
    externalId:
      firstString(record, ["id", "item_id", "itemId", "product_id", "productId", "goods_id", "goodsId"]) ??
      firstString(nested, ["id", "item_id", "itemId", "product_id", "productId", "goods_id", "goodsId"]),
    title,
    price:
      firstString(record, ["price", "item_price", "itemPrice", "amount", "sale_price", "salePrice", "sell_price", "current_price"]) ??
      firstString(nested, ["price", "item_price", "itemPrice", "amount", "sale_price", "salePrice", "sell_price", "current_price"]),
    description:
      firstString(record, ["description", "item_description", "itemDescription", "desc", "detail", "item_detail", "intro", "summary", "content"]) ??
      firstString(nested, ["description", "item_description", "itemDescription", "desc", "detail", "item_detail", "intro", "summary", "content"]),
    imageUrl:
      firstString(record, [
        "pic", "pic_url", "picUrl", "image", "image_url", "imageUrl", "cover", "cover_url",
        "thumb", "thumbnail", "main_image", "mainPicUrl", "img", "photo",
      ]) ?? firstString(nested, ["pic", "pic_url", "image", "image_url", "cover", "thumb", "img"]),
    raw: item,
  };
}

async function callExternal(
  url: string,
  apiKey: string,
  init: { method: "GET" | "POST"; body?: string },
): Promise<{ request: ExternalRequestLog; response: ExternalResponseLog | null; fetchError?: string }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const requestLog: ExternalRequestLog = {
    method: init.method,
    url,
    headers: { ...headers, Authorization: `Bearer ${maskApiKey(apiKey)}` },
    body: init.body ? prettyJson(init.body) : null,
  };
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: init.method,
      headers,
      body: init.body,
      signal: AbortSignal.timeout(20000),
    });
    const text = await response.text();
    return {
      request: requestLog,
      response: {
        status: response.status,
        contentType: response.headers.get("content-type"),
        durationMs: Date.now() - startedAt,
        bodyText: prettyJson(text),
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      request: requestLog,
      response: null,
      fetchError: detail,
    };
  }
}

/**
 * 导入闲鱼商品：
 * - GET：{url}?{paramName}=N（同时携带 Bearer apikey）
 * - POST：请求体 JSON { {paramName}: N }（同时携带 Bearer apikey）
 * 条数范围 1-200（与闲鱼开放接口文档对齐），响应自动归一化为商品列表（兼容 groups[].items[] 多账号分组）
 */
export async function fetchXianyuProducts(input: {
  url: string;
  apiKey: string;
  count: number;
  paramName?: string;
  method?: "GET" | "POST";
}): Promise<XianyuImportResult> {
  const base = input.url.trim();
  const method: "GET" | "POST" = input.method === "POST" ? "POST" : "GET";
  const paramName = (input.paramName ?? "count").trim() || "count";
  const count = Math.max(1, Math.min(input.count, 200));

  let url = base;
  let body: string | undefined;
  if (method === "GET") {
    url = `${base}${base.includes("?") ? "&" : "?"}${encodeURIComponent(paramName)}=${count}`;
  } else {
    body = JSON.stringify({ [paramName]: count });
  }

  const { request, response, fetchError } = await callExternal(url, input.apiKey, { method, body });

  if (!response) {
    return { ok: false, products: [], error: `商品接口请求失败：${fetchError}`, request, response: null };
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      products: [],
      error: `商品接口返回状态码 ${response.status}：${response.bodyText.slice(0, 200)}`,
      request,
      response,
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(response.bodyText);
  } catch {
    return { ok: false, products: [], error: "商品接口响应不是合法 JSON", request, response };
  }

  const products = extractArray(payload)
    .map(normalizeProduct)
    .filter((item): item is NormalizedProduct => item !== null);

  if (products.length === 0) {
    return { ok: false, products: [], error: "商品接口响应中未识别到商品（需要 list/items/根数组，且每项包含 title/name 字段）", request, response };
  }
  return { ok: true, products: products.slice(0, count), request, response };
}

export interface DeliverProductInput {
  externalId: string | null;
  productId: bigint;
  title: string;
  price: string | null;
}

const CODE_KEYS = [
  "verify_code", "verifyCode", "verification_code", "verificationCode",
  "card_key", "cardKey", "cardno", "card_no", "captcha", "token", "code",
];

/** 视为状态码的键名（这些键下的纯数字值是业务状态码，不是卡密） */
const GENERIC_STATUS_KEYS = new Set([
  "code", "ret", "retcode", "status", "status_code", "statuscode", "errcode", "error_code",
]);

/** 常见卡密数组容器键（如 data.items[].code） */
const CODE_ARRAY_KEYS = ["items", "cards", "list", "records", "rows", "codes", "coupons"];

/**
 * 校验候选值是否像卡密：
 * - 纯数字 100-599 视为 HTTP 风格状态码（如 "code": 200），直接排除；
 * - 键名为 code/ret/status 等且值为 JSON number（如 "code": 200）视为业务状态码，排除；
 * - 真实卡密通常为字符串（如 "625995"、"A3b9xK"），6 位纯数字字符串（卡密生成器常见）不受影响。
 */
function acceptCodeCandidate(key: string, value: unknown): string | null {
  let text: string | null = null;
  if (typeof value === "string" && value.trim()) text = value.trim();
  else if (typeof value === "number" && Number.isFinite(value)) text = String(value);
  if (!text) return null;
  if (/^[1-5]\d{2}$/.test(text)) return null;
  if (typeof value === "number" && GENERIC_STATUS_KEYS.has(key.toLowerCase())) return null;
  return text;
}

function scanCodeRecord(record: Record<string, unknown>): string | null {
  for (const key of CODE_KEYS) {
    const accepted = acceptCodeCandidate(key, record[key]);
    if (accepted) return accepted;
  }
  return null;
}

function scanCodeArray(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const element of value) {
    if (typeof element === "string") {
      const accepted = acceptCodeCandidate("code", element);
      if (accepted) return accepted;
    } else if (typeof element === "object" && element !== null) {
      const accepted = scanCodeRecord(element as Record<string, unknown>);
      if (accepted) return accepted;
    }
  }
  return null;
}

function readJsonPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** 从发货响应中宽容提取测试加群验证码（自动跳过 "code": 200 之类的状态码） */
export function extractVerifyCode(payload: unknown, rawText: string): string | null {
  const candidateRoots = [payload, readJsonPath(payload, "data"), readJsonPath(payload, "result")];
  for (const root of candidateRoots) {
    if (typeof root !== "object" || root === null) continue;
    const record = root as Record<string, unknown>;
    const direct = scanCodeRecord(record);
    if (direct) return direct;
    // 扫描数组容器：兼容 data.items[].code / data.cards[].card_key 等结构
    for (const key of CODE_ARRAY_KEYS) {
      const accepted = scanCodeArray(record[key]);
      if (accepted) return accepted;
    }
  }
  const nested = [
    "data.code", "data.verify_code", "data.verification_code", "data.card_key",
    "data.items.0.code", "data.cards.0.code", "data.cards.0.card_key",
    "result.code", "result.data.code", "result.items.0.code",
  ];
  for (const path of nested) {
    const value = readJsonPath(payload, path);
    if (typeof value === "string" && value.trim() && !/^[1-5]\d{2}$/.test(value.trim())) return value.trim();
  }
  // 正则兜底：逐个匹配并跳过状态码样式的值（如 "code": 200）
  const matcher = /(?:验证码|卡密|verify[_ ]?code|card[_ ]?key|code)["'\s:：]+["']?([A-Za-z0-9-]{4,32})/gi;
  for (const match of rawText.matchAll(matcher)) {
    const candidate = match[1];
    if (candidate && !/^[1-5]\d{2}$/.test(candidate)) return candidate;
  }
  return null;
}

function isSuccessPayload(payload: unknown, status: number): boolean {
  if (status < 200 || status >= 300) return false;
  if (typeof payload === "object" && payload !== null) {
    const record = payload as Record<string, unknown>;
    if (typeof record.success === "boolean") return record.success;
    if (typeof record.ok === "boolean") return record.ok;
    const valid = readJsonPath(payload, "data.valid");
    if (typeof valid === "boolean") return valid;
  }
  return true;
}

/** 模拟发货：POST 发货 API（Bearer apikey），返回验证码与完整请求/响应日志 */
export async function deliverXianyuProduct(input: {
  url: string;
  apiKey: string;
  product: DeliverProductInput;
}): Promise<XianyuDeliverResult> {
  const orderNo = `XY${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const body = JSON.stringify({
    product_id: input.product.externalId ?? String(input.product.productId),
    product_title: input.product.title,
    price: input.product.price ?? null,
    order_no: orderNo,
    quantity: 1,
    user_id: 777000,
    username: "preview_user",
    source: "tguard-simulator",
  });
  const { request, response, fetchError } = await callExternal(input.url.trim(), input.apiKey, {
    method: "POST",
    body,
  });

  if (!response) {
    return { ok: false, code: null, message: null, error: `发货接口请求失败：${fetchError}`, request, response: null };
  }

  let payload: unknown = null;
  try {
    payload = JSON.parse(response.bodyText);
  } catch {
    payload = null;
  }

  const code = extractVerifyCode(payload, response.bodyText);
  const ok = isSuccessPayload(payload, response.status);
  const message =
    typeof payload === "object" && payload !== null
      ? (() => {
          const record = payload as Record<string, unknown>;
          const msg = record.msg ?? record.message ?? record.error;
          return typeof msg === "string" ? msg : null;
        })()
      : null;

  return {
    ok: ok && Boolean(code),
    code,
    message: message ?? (ok ? "发货成功" : `发货接口返回状态码 ${response.status}`),
    error: ok ? undefined : message ?? `发货接口返回状态码 ${response.status}`,
    request,
    response,
  };
}
