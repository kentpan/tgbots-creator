import { executeRun, queryAll, queryOne, type SqlParam } from "./client";

export interface XianyuProductRow {
  id: bigint;
  externalId: string | null;
  title: string;
  price: string | null;
  description: string | null;
  imageUrl: string | null;
  detailJson: string | null;
  sourceUrl: string | null;
  rawJson: string | null;
  createdTime: Date;
}

export interface XianyuDeliveryLogRow {
  id: bigint;
  productId: bigint | null;
  apiUrl: string;
  requestMethod: string;
  requestHeaders: string | null;
  requestBody: string | null;
  responseStatus: number | null;
  responseBody: string | null;
  durationMs: number | null;
  verifyCode: string | null;
  success: boolean;
  error: string | null;
  createdTime: Date;
}

export interface VerifyCodeRow {
  id: bigint;
  code: string;
  productId: bigint | null;
  orderNo: string | null;
  status: string;
  usedByUserId: bigint | null;
  usedChatId: bigint | null;
  usedTime: Date | null;
  expiresAt: Date;
  createdTime: Date;
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    return new Date(value.includes("T") ? value : value.replace(" ", "T") + (value.endsWith("Z") ? "" : "Z"));
  }
  if (typeof value === "number") return new Date(value);
  return new Date();
}

function mapProduct(row: Record<string, unknown>): XianyuProductRow {
  return {
    id: BigInt(row.id as number),
    externalId: (row.external_id as string | null) ?? null,
    title: (row.title as string) ?? "",
    price: (row.price as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    imageUrl: (row.image_url as string | null) ?? null,
    detailJson: (row.detail_json as string | null) ?? null,
    sourceUrl: (row.source_url as string | null) ?? null,
    rawJson: (row.raw_json as string | null) ?? null,
    createdTime: toDate(row.created_time),
  };
}

function mapDeliveryLog(row: Record<string, unknown>): XianyuDeliveryLogRow {
  return {
    id: BigInt(row.id as number),
    productId: toBigIntOrNullSafe(row.product_id),
    apiUrl: (row.api_url as string) ?? "",
    requestMethod: (row.request_method as string) ?? "POST",
    requestHeaders: (row.request_headers as string | null) ?? null,
    requestBody: (row.request_body as string | null) ?? null,
    responseStatus: (row.response_status as number | null) ?? null,
    responseBody: (row.response_body as string | null) ?? null,
    durationMs: (row.duration_ms as number | null) ?? null,
    verifyCode: (row.verify_code as string | null) ?? null,
    success: row.success === 1 || row.success === 1n || row.success === true,
    error: (row.error as string | null) ?? null,
    createdTime: toDate(row.created_time),
  };
}

function mapVerifyCode(row: Record<string, unknown>): VerifyCodeRow {
  return {
    id: BigInt(row.id as number),
    code: (row.code as string) ?? "",
    productId: toBigIntOrNullSafe(row.product_id),
    orderNo: (row.order_no as string | null) ?? null,
    status: (row.status as string) ?? "unused",
    usedByUserId: toBigIntOrNullSafe(row.used_by_user_id),
    usedChatId: toBigIntOrNullSafe(row.used_chat_id),
    usedTime: row.used_time ? toDate(row.used_time) : null,
    expiresAt: toDate(row.expires_at),
    createdTime: toDate(row.created_time),
  };
}

/** 宽容解析：数字字符串 → bigint；其他（如外部商品 ID "xy_1001"）→ null */
function toBigIntOrNullSafe(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isFinite(value) ? BigInt(Math.trunc(value)) : null;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  return null;
}

export async function listXianyuProducts(limit = 100): Promise<XianyuProductRow[]> {
  const rows = await queryAll<Record<string, unknown>>(
    `SELECT * FROM xianyu_products ORDER BY id DESC LIMIT ?`,
    [limit],
  );
  return rows.map(mapProduct);
}

export async function getXianyuProduct(id: bigint): Promise<XianyuProductRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM xianyu_products WHERE id = ?`,
    [Number(id)],
  );
  return row ? mapProduct(row) : null;
}

export interface CreateXianyuProductInput {
  externalId?: string | null;
  title: string;
  price?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  detailJson?: string | null;
  sourceUrl?: string | null;
  rawJson?: string | null;
}

export async function createXianyuProduct(input: CreateXianyuProductInput): Promise<XianyuProductRow | null> {
  const result = await executeRun(
    `INSERT INTO xianyu_products (external_id, title, price, description, image_url, detail_json, source_url, raw_json, created_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.externalId ?? null,
      input.title,
      input.price ?? null,
      input.description ?? null,
      input.imageUrl ?? null,
      input.detailJson ?? null,
      input.sourceUrl ?? null,
      input.rawJson ?? null,
      new Date().toISOString(),
    ] satisfies SqlParam[],
  );
  if (result.changes !== 1) return null;
  return getXianyuProduct(BigInt(result.lastInsertRowid));
}

/**
 * 按 external_id 更新式导入：已存在同外部 ID 的商品时刷新其内容（不新增重复行），否则新插入。
 * externalId 为空时始终新插入。返回落库行与是否为新创建。
 */
export async function upsertXianyuProduct(
  input: CreateXianyuProductInput,
): Promise<{ row: XianyuProductRow; created: boolean } | null> {
  const externalId = input.externalId?.trim() || null;
  if (externalId) {
    const existing = await queryOne<{ id: number }>(
      `SELECT id FROM xianyu_products WHERE external_id = ? ORDER BY id DESC LIMIT 1`,
      [externalId],
    );
    if (existing) {
      await executeRun(
        `UPDATE xianyu_products
           SET title = ?, price = ?, description = ?, image_url = ?, detail_json = ?, source_url = ?, raw_json = ?
         WHERE id = ?`,
        [
          input.title,
          input.price ?? null,
          input.description ?? null,
          input.imageUrl ?? null,
          input.detailJson ?? null,
          input.sourceUrl ?? null,
          input.rawJson ?? null,
          Number(existing.id),
        ] satisfies SqlParam[],
      );
      const row = await getXianyuProduct(BigInt(existing.id));
      return row ? { row, created: false } : null;
    }
  }
  const row = await createXianyuProduct({ ...input, externalId });
  return row ? { row, created: true } : null;
}

export async function createXianyuDeliveryLog(input: {
  productId?: bigint | null;
  apiUrl: string;
  requestMethod?: string;
  requestHeaders?: string | null;
  requestBody?: string | null;
  responseStatus?: number | null;
  responseBody?: string | null;
  durationMs?: number | null;
  verifyCode?: string | null;
  success?: boolean;
  error?: string | null;
}): Promise<XianyuDeliveryLogRow | null> {
  const result = await executeRun(
    `INSERT INTO xianyu_delivery_logs
       (product_id, api_url, request_method, request_headers, request_body, response_status, response_body, duration_ms, verify_code, success, error, created_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.productId === undefined || input.productId === null ? null : Number(input.productId),
      input.apiUrl,
      input.requestMethod ?? "POST",
      input.requestHeaders ?? null,
      input.requestBody ?? null,
      input.responseStatus === undefined || input.responseStatus === null ? null : input.responseStatus,
      input.responseBody ?? null,
      input.durationMs === undefined || input.durationMs === null ? null : input.durationMs,
      input.verifyCode ?? null,
      input.success ? 1 : 0,
      input.error ?? null,
      new Date().toISOString(),
    ] satisfies SqlParam[],
  );
  if (result.changes !== 1) return null;
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM xianyu_delivery_logs WHERE id = ?`,
    [result.lastInsertRowid],
  );
  return row ? mapDeliveryLog(row) : null;
}

export async function listXianyuDeliveryLogs(options?: {
  productId?: bigint | null;
  limit?: number;
}): Promise<XianyuDeliveryLogRow[]> {
  const limit = options?.limit ?? 20;
  if (options?.productId !== undefined && options.productId !== null) {
    const rows = await queryAll<Record<string, unknown>>(
      `SELECT * FROM xianyu_delivery_logs WHERE product_id = ? ORDER BY id DESC LIMIT ?`,
      [Number(options.productId), limit],
    );
    return rows.map(mapDeliveryLog);
  }
  const rows = await queryAll<Record<string, unknown>>(
    `SELECT * FROM xianyu_delivery_logs ORDER BY id DESC LIMIT ?`,
    [limit],
  );
  return rows.map(mapDeliveryLog);
}

export async function getVerifyCodeByCode(code: string): Promise<VerifyCodeRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM verify_codes WHERE code = ?`,
    [code],
  );
  return row ? mapVerifyCode(row) : null;
}

/** 发码：创建一条未使用验证码（发货 API /api/verify-codes/issue 调用） */
export async function createVerifyCode(input: {
  code: string;
  productId?: string | null;
  orderNo?: string | null;
  ttlMinutes?: number;
}): Promise<VerifyCodeRow> {
  const ttl = input.ttlMinutes && input.ttlMinutes > 0 ? input.ttlMinutes : 30;
  const expiresAt = new Date(Date.now() + ttl * 60 * 1000);
  await executeRun(
    `INSERT INTO verify_codes (code, product_id, order_no, status, expires_at, created_time)
     VALUES (?, ?, ?, 'unused', ?, ?)`,
    [input.code, input.productId ?? null, input.orderNo ?? null, expiresAt.toISOString(), new Date().toISOString()] satisfies SqlParam[],
  );
  const row = await getVerifyCodeByCode(input.code);
  if (!row) throw new Error("verify code insert failed");
  return row;
}

export interface ConsumeVerifyCodeResult {
  valid: boolean;
  reason?: string;
  row?: VerifyCodeRow;
}

/** 验码：校验并消费验证码（外部验证 API /api/verify-codes/verify 调用） */
export async function consumeVerifyCode(
  code: string,
  input: { userId?: bigint | null; chatId?: bigint | null },
): Promise<ConsumeVerifyCodeResult> {
  const row = await getVerifyCodeByCode(code);
  if (!row) {
    return { valid: false, reason: "验证码不存在" };
  }
  if (row.status === "used") {
    return { valid: false, reason: "验证码已被使用" };
  }
  if (row.status === "expired" || new Date() > row.expiresAt) {
    if (row.status !== "expired") {
      await executeRun(`UPDATE verify_codes SET status = 'expired' WHERE id = ? AND status = 'unused'`, [Number(row.id)]);
    }
    return { valid: false, reason: "验证码已过期" };
  }
  const result = await executeRun(
    `UPDATE verify_codes
     SET status = 'used', used_by_user_id = ?, used_chat_id = ?, used_time = ?
     WHERE id = ? AND status = 'unused'`,
    [
      input.userId === undefined || input.userId === null ? null : Number(input.userId),
      input.chatId === undefined || input.chatId === null ? null : Number(input.chatId),
      new Date().toISOString(),
      Number(row.id),
    ] satisfies SqlParam[],
  );
  if (result.changes !== 1) {
    return { valid: false, reason: "验证码已被使用" };
  }
  return { valid: true, row: { ...row, status: "used", usedByUserId: input.userId ?? null, usedChatId: input.chatId ?? null, usedTime: new Date() } };
}
