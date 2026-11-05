import {
  executeRun,
  queryAll,
  queryOne,
  type SqlParam,
} from "@/database/client";
import { cachedJson, invalidateCache } from "@/database/bindings";

export const RequestStatus = {
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  EXPIRED: "expired",
} as const;

export interface JoinRequestRow {
  id: bigint;
  userId: bigint;
  chatId: bigint;
  username: string | null;
  firstName: string;
  lastName: string | null;
  verificationToken: string;
  status: string;
  requestTime: Date;
  processedTime: Date | null;
  adminId: bigint | null;
  verificationCompleted: boolean;
  requestType: string;
}

export interface VerificationSessionRow {
  id: bigint;
  token: string;
  userId: bigint;
  chatId: bigint;
  captchaCompleted: boolean;
  captchaResponse: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdTime: Date;
  completedTime: Date | null;
  expiresAt: Date;
  method: string;
  attempts: number;
  /** v1.1.7 code_self 方式：机器人自生成、用户需回输的入群验证码（明文，与 verify_codes 卡密表同安全级别）；其他方式为 NULL */
  expectedCode: string | null;
}

export interface VerificationStats {
  total_requests: number;
  approved: number;
  rejected: number;
  pending: number;
  expired: number;
  approval_rate: number;
}

export interface GlobalVerificationStats extends VerificationStats {
  today_total: number;
  today_approved: number;
  today_approval_rate: number;
}

export interface CreateJoinRequestInput {
  userId: bigint;
  chatId: bigint;
  username: string | null;
  firstName: string;
  lastName: string | null;
  verificationToken: string;
  requestType?: string;
}

export interface RoleRow {
  id: bigint;
  code: string;
  name: string;
  description: string | null;
  isBuiltin: boolean;
  createdTime: Date;
}

export interface PermissionRow {
  id: bigint;
  code: string;
  name: string;
  description: string | null;
  sortOrder: number;
}

export interface AdminUserRow {
  id: bigint;
  username: string;
  passwordHash: string;
  displayName: string | null;
  roleId: bigint;
  status: string;
  createdTime: Date;
  lastLoginTime: Date | null;
}

export interface AdminSessionContext {
  session: {
    id: bigint;
    userId: bigint;
    tokenHash: string;
    expiresAt: Date;
    ipAddress: string | null;
    userAgent: string | null;
  };
  user: AdminUserRow & { roleName: string; roleCode: string };
  permissions: string[];
}

export interface MenuRow {
  id: bigint;
  parentId: bigint;
  title: string;
  path: string;
  icon: string | null;
  sortOrder: number;
  visible: boolean;
  permissionCode: string | null;
  status: number;
  createdTime: Date;
  updatedTime: Date;
}

export interface GroupSettingsRow {
  chatId: bigint;
  chatTitle: string | null;
  method: string;
  methodId: bigint | null;
  timeoutSeconds: number;
  maxAttempts: number;
  promptText: string;
  successText: string;
  failureText: string;
  enabled: boolean;
  /** 加群验证隐私模式：开启时验证码必须回复机器人的验证问题（stateless-question，兼容 Telegram 隐私模式）；关闭时任意文本消息均可触发校验 */
  privacyMode: boolean;
  /** 加群需要管理员审核（v1.1.9，对应 TG APP 群设置的「审批新成员」）：Bot API 无远程开关，本字段控制本系统生成的部署链接语义与直连入群防线 */
  requireApproval: boolean;
  createdTime: Date;
  updatedTime: Date;
}

export interface VerificationMethodRow {
  id: bigint;
  name: string;
  type: string;
  config: string;
  enabled: boolean;
  createdTime: Date;
  updatedTime: Date;
}

export interface OperationLogRow {
  id: bigint;
  adminId: bigint | null;
  adminUsername: string | null;
  action: string;
  target: string | null;
  detail: string | null;
  ipAddress: string | null;
  createdTime: Date;
}

function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string") return value === "" ? 0n : BigInt(value);
  return 0n;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return value === "" ? 0 : Number(value);
  return 0;
}

function toBoolean(value: unknown): boolean {
  return value === 1 || value === 1n || value === true || value === "1";
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string") return new Date(value.includes("T") ? value : value.replace(" ", "T") + (value.endsWith("Z") ? "" : "Z"));
  if (typeof value === "number") return new Date(value);
  return new Date();
}

function toDateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return toDate(value);
}

function toBigIntOrNull(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  return toBigInt(value);
}

function dateText(date: Date): string {
  return date.toISOString();
}

function mapJoinRequest(row: Record<string, unknown>): JoinRequestRow {
  return {
    id: toBigInt(row.id),
    userId: toBigInt(row.user_id),
    chatId: toBigInt(row.chat_id),
    username: (row.username as string | null) ?? null,
    firstName: (row.first_name as string) ?? "",
    lastName: (row.last_name as string | null) ?? null,
    verificationToken: row.verification_token as string,
    status: row.status as string,
    requestTime: toDate(row.request_time),
    processedTime: toDateOrNull(row.processed_time),
    adminId: toBigIntOrNull(row.admin_id),
    verificationCompleted: toBoolean(row.verification_completed),
    requestType: (row.request_type as string) ?? "telegram",
  };
}

function mapSession(row: Record<string, unknown>): VerificationSessionRow {
  return {
    id: toBigInt(row.id),
    token: row.token as string,
    userId: toBigInt(row.user_id),
    chatId: toBigInt(row.chat_id),
    captchaCompleted: toBoolean(row.captcha_completed),
    captchaResponse: (row.captcha_response as string | null) ?? null,
    ipAddress: (row.ip_address as string | null) ?? null,
    userAgent: (row.user_agent as string | null) ?? null,
    createdTime: toDate(row.created_time),
    completedTime: toDateOrNull(row.completed_time),
    expiresAt: toDate(row.expires_at),
    method: (row.method as string) ?? "captcha",
    attempts: toNumber(row.attempts ?? 0),
    expectedCode: (row.expected_code as string | null) ?? null,
  };
}

export async function createJoinRequest(
  input: CreateJoinRequestInput,
): Promise<JoinRequestRow | null> {
  const userId = Number(input.userId);
  const chatId = Number(input.chatId);
  const requestType = input.requestType ?? "telegram";
  try {
    const existing = await queryOne<Record<string, unknown>>(
      `SELECT id, verification_token FROM join_requests
       WHERE user_id = ? AND chat_id = ? AND status = ?
       ORDER BY request_time DESC LIMIT 1`,
      [userId, chatId, RequestStatus.PENDING],
    );

    if (existing) {
      await executeRun(
        `UPDATE verification_sessions SET expires_at = ? WHERE token = ? AND captcha_completed = 0`,
        [dateText(new Date()), existing.verification_token as string],
      );
      const result = await executeRun(
        `UPDATE join_requests
         SET verification_token = ?, request_type = ?, request_time = ?,
             verification_completed = 0, processed_time = NULL, admin_id = NULL
         WHERE id = ?`,
        [
          input.verificationToken,
          requestType,
          dateText(new Date()),
          Number(existing.id),
        ],
      );
      if (result.changes !== 1) return null;
      return await getJoinRequestByToken(input.verificationToken);
    }

    const result = await executeRun(
      `INSERT INTO join_requests
         (user_id, chat_id, username, first_name, last_name, verification_token, status, request_time, verification_completed, request_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        userId,
        chatId,
        input.username,
        input.firstName,
        input.lastName,
        input.verificationToken,
        RequestStatus.PENDING,
        dateText(new Date()),
        requestType,
      ],
    );
    if (result.changes !== 1) return null;
    return await getJoinRequestByToken(input.verificationToken);
  } catch (error) {
    console.error("Error creating join request:", error);
    return null;
  }
}

export async function createVerificationSession(input: {
  token: string;
  userId: bigint;
  chatId: bigint;
  expiresAt: Date;
  method?: string;
  /** v1.1.7 code_self：机器人自生成的入群验证码，随会话落库，输入时本地比对 */
  expectedCode?: string | null;
}): Promise<VerificationSessionRow | null> {
  try {
    await executeRun(
      `UPDATE verification_sessions SET expires_at = ? WHERE token = ? AND captcha_completed = 0`,
      [dateText(new Date()), input.token],
    );
    const result = await executeRun(
      `INSERT INTO verification_sessions
         (token, user_id, chat_id, captcha_completed, created_time, expires_at, method, attempts, expected_code)
       VALUES (?, ?, ?, 0, ?, ?, ?, 0, ?)`,
      [
        input.token,
        Number(input.userId),
        Number(input.chatId),
        dateText(new Date()),
        dateText(input.expiresAt),
        input.method ?? "captcha",
        input.expectedCode ?? null,
      ],
    );
    if (result.changes !== 1) return null;
    return await getVerificationSession(input.token);
  } catch (error) {
    console.error("Error creating verification session:", error);
    return null;
  }
}

export async function getVerificationSession(
  token: string,
): Promise<VerificationSessionRow | null> {
  try {
    const row = await queryOne<Record<string, unknown>>(
      `SELECT * FROM verification_sessions WHERE token = ?`,
      [token],
    );
    return row ? mapSession(row) : null;
  } catch (error) {
    console.error("Error getting verification session:", error);
    return null;
  }
}

export function isSessionExpired(session: VerificationSessionRow): boolean {
  return new Date() > session.expiresAt;
}

export async function completeVerification(input: {
  token: string;
  captchaResponse: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<boolean> {
  const { token, captchaResponse, ipAddress, userAgent } = input;
  try {
    const result = await executeRun(
      `UPDATE verification_sessions
       SET captcha_completed = 1, captcha_response = ?, ip_address = ?, user_agent = ?, completed_time = ?
       WHERE token = ? AND captcha_completed = 0 AND expires_at > ?`,
      [
        captchaResponse,
        ipAddress ?? null,
        userAgent ?? null,
        dateText(new Date()),
        token,
        dateText(new Date()),
      ],
    );

    if (result.changes !== 1) {
      console.warn(
        `Verification session already completed or expired: ${token.slice(0, 8)}...`,
      );
      return false;
    }

    await executeRun(
      `UPDATE join_requests SET verification_completed = 1 WHERE verification_token = ?`,
      [token],
    );
    return true;
  } catch (error) {
    console.error("Error completing verification:", error);
    return false;
  }
}

export async function incrementSessionAttempts(token: string): Promise<number> {
  await executeRun(
    `UPDATE verification_sessions SET attempts = attempts + 1 WHERE token = ?`,
    [token],
  );
  const session = await getVerificationSession(token);
  return session ? session.attempts : 0;
}

export async function expireVerificationSession(token: string): Promise<void> {
  await executeRun(
    `UPDATE verification_sessions SET expires_at = ? WHERE token = ? AND captcha_completed = 0`,
    [dateText(new Date()), token],
  );
}

export async function approveJoinRequest(
  token: string,
  adminId?: bigint | null,
): Promise<boolean> {
  try {
    await executeRun(
      `UPDATE join_requests
       SET status = ?, processed_time = ?, admin_id = ?
       WHERE verification_token = ?`,
      [RequestStatus.APPROVED, dateText(new Date()), adminId === undefined || adminId === null ? null : Number(adminId), token],
    );
    return true;
  } catch (error) {
    console.error("Error approving join request:", error);
    return false;
  }
}

export async function rejectJoinRequest(
  token: string,
  adminId?: bigint | null,
): Promise<boolean> {
  try {
    await executeRun(
      `UPDATE join_requests
       SET status = ?, processed_time = ?, admin_id = ?
       WHERE verification_token = ?`,
      [RequestStatus.REJECTED, dateText(new Date()), adminId === undefined || adminId === null ? null : Number(adminId), token],
    );
    return true;
  } catch (error) {
    console.error("Error rejecting join request:", error);
    return false;
  }
}

export async function getJoinRequestByToken(
  token: string,
): Promise<JoinRequestRow | null> {
  try {
    const row = await queryOne<Record<string, unknown>>(
      `SELECT * FROM join_requests WHERE verification_token = ?`,
      [token],
    );
    return row ? mapJoinRequest(row) : null;
  } catch (error) {
    console.error("Error getting join request:", error);
    return null;
  }
}

export async function getPendingRequests(
  chatId: bigint,
  limit = 50,
): Promise<JoinRequestRow[]> {
  try {
    const rows = await queryAll<Record<string, unknown>>(
      `SELECT * FROM join_requests WHERE chat_id = ? AND status = ?
       ORDER BY request_time DESC LIMIT ?`,
      [Number(chatId), RequestStatus.PENDING, limit],
    );
    return rows.map(mapJoinRequest);
  } catch (error) {
    console.error("Error getting pending requests:", error);
    return [];
  }
}

function buildStatusStats(
  rows: { status: string; count: number }[],
): Pick<VerificationStats, "total_requests" | "approved" | "rejected" | "pending" | "expired"> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.status] = row.count;
  }

  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return {
    total_requests: total,
    approved: counts[RequestStatus.APPROVED] ?? 0,
    rejected: counts[RequestStatus.REJECTED] ?? 0,
    pending: counts[RequestStatus.PENDING] ?? 0,
    expired: counts[RequestStatus.EXPIRED] ?? 0,
  };
}

async function groupStatusCounts(where?: string, params: SqlParam[] = []) {
  const sql = `SELECT status, COUNT(id) AS count FROM join_requests ${
    where ? `WHERE ${where}` : ""
  } GROUP BY status`;
  const rows = await queryAll<{ status: string; count: number }>(sql, params);
  return rows.map((row) => ({
    status: String(row.status),
    count: toNumber(row.count),
  }));
}

export async function getVerificationStats(
  chatId: bigint,
): Promise<VerificationStats> {
  try {
    const grouped = await groupStatusCounts("chat_id = ?", [Number(chatId)]);
    const base = buildStatusStats(grouped);
    return {
      ...base,
      approval_rate:
        base.total_requests > 0 ? (base.approved / base.total_requests) * 100 : 0,
    };
  } catch (error) {
    console.error("Error getting verification stats:", error);
    return {
      total_requests: 0,
      approved: 0,
      rejected: 0,
      pending: 0,
      expired: 0,
      approval_rate: 0,
    };
  }
}

export async function getGlobalStats(): Promise<GlobalVerificationStats | null> {
  try {
    const grouped = await groupStatusCounts();

    const now = new Date();
    const todayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

    const todayGrouped = await groupStatusCounts("request_time >= ? AND request_time < ?", [
      dateText(todayStart),
      dateText(todayEnd),
    ]);

    const base = buildStatusStats(grouped);
    const today = buildStatusStats(todayGrouped);

    return {
      ...base,
      approval_rate:
        base.total_requests > 0 ? (base.approved / base.total_requests) * 100 : 0,
      today_total: today.total_requests,
      today_approved: today.approved,
      today_approval_rate:
        today.total_requests > 0 ? (today.approved / today.total_requests) * 100 : 0,
    };
  } catch (error) {
    console.error("Error getting global stats:", error);
    return null;
  }
}

export async function cleanupExpiredSessions(): Promise<ExpiredSessionTarget[]> {
  try {
    const nowIso = dateText(new Date());
    // v1.1.4 修复①：只取最近过期的一批（新→旧，LIMIT 400），IN 列表恒有界。
    // 会话行不做「已处理」标记（无状态列），30 天保留期内始终会被扫出——
    // 若不设批次上限，生产环境积压会撑爆 SQLite 999 绑定变量上限，
    // 整个清理循环（含新过期会话的处理）随之整体失效。
    // 取新弃旧：新过期会话必须及时处理；极老的积压行仅停留 pending（无功能影响，
    // 验证判定以 isSessionExpired 为准），由下方修复②保证其状态合法性。
    const expiredSessions = await queryAll<{ token: string }>(
      `SELECT token FROM verification_sessions
       WHERE expires_at < ? AND captcha_completed = 0
       ORDER BY expires_at DESC LIMIT 400`,
      [nowIso],
    );
    const tokens = expiredSessions.map((row) => row.token);

    if (tokens.length === 0) {
      return [];
    }

    // v1.1.4 修复②（历史脏数据自愈）：旧版下方 UPDATE 的绑定参数整体错位，把
    // tokens[0]（某个过期会话的 32 位 token）写进了 join_requests.status
    // （2026-11-03 实证：id=18/20 status 变成 qHOhAQOD… 串）。凡不属于
    // 合法状态枚举的行都是该 bug 的确定性产物——对应会话必然已过期未完成，
    // 统一修复为 expired。幂等，每轮清理先执行。
    await executeRun(
      `UPDATE join_requests SET status = ?
       WHERE status IS NOT NULL AND status NOT IN (?, ?, ?, ?)`,
      [
        RequestStatus.EXPIRED,
        RequestStatus.PENDING,
        RequestStatus.APPROVED,
        RequestStatus.REJECTED,
        RequestStatus.EXPIRED,
      ],
    );

    const placeholders = tokens.map(() => "?").join(", ");
    const pendingRequests = await queryAll<{
      chat_id: number;
      user_id: number;
      request_type: string;
    }>(
      `SELECT chat_id, user_id, request_type FROM join_requests
       WHERE verification_token IN (${placeholders}) AND status = ?`,
      [...tokens, RequestStatus.PENDING],
    );

    // telegram = 需拒绝 Telegram 侧加群申请；direct = 直连入群，需踢出未验证成员；
    // simulator 等其他类型不动作（与既有行为一致）
    const toProcess: ExpiredSessionTarget[] = pendingRequests
      .filter((row) => Number(row.chat_id) !== 0)
      .filter((row) => row.request_type === "telegram" || row.request_type === "direct")
      .map((row) => ({
        chatId: toBigInt(row.chat_id),
        userId: toBigInt(row.user_id),
        requestType: row.request_type,
      }));

    // v1.1.4 修复③（原 bug 本体）：占位符顺序为 SET status=? / IN(...)/ AND status=?，
    // 绑定数组必须一一对应为 [EXPIRED, ...tokens, PENDING]。旧实现
    // [...tokens, EXPIRED, PENDING] 把 tokens[0] 写进 status、IN 列表整体右移——
    // 单 token 轮次 WHERE 永不匹配（目标每 60s 重复通知），多 token 轮次则把
    // token 串写入 status（数据污染）。修复后本批 pending 申请一次性置为 expired，
    // 下一轮 target SELECT（要求 status=pending）不再命中，通知严格一次性。
    await executeRun(
      `UPDATE join_requests SET status = ? WHERE verification_token IN (${placeholders}) AND status = ?`,
      [RequestStatus.EXPIRED, ...tokens, RequestStatus.PENDING],
    );

    return toProcess;
  } catch (error) {
    console.error("Error cleaning up expired sessions:", error);
    return [];
  }
}

/** 过期会话的后续动作目标（v1.1.3：携带申请类型，direct 类型需踢出未验证成员） */
export interface ExpiredSessionTarget {
  chatId: bigint;
  userId: bigint;
  requestType: string;
}

/**
 * 用户离开群组时清理其未完成的验证任务（v1.1.3，直连入群防线配套）：
 * 将该用户在该群组的未完成 code_api/captcha 会话置为已过期，
 * 并把关联的 pending 加群申请置为 rejected，避免悬挂任务在 /start 重发提示。
 */
export async function expirePendingSessionsForUserChat(
  userId: bigint,
  chatId: bigint,
): Promise<boolean> {
  try {
    const nowIso = dateText(new Date());
    const rows = await queryAll<{ token: string }>(
      `SELECT s.token AS token FROM verification_sessions s
       JOIN join_requests j ON j.verification_token = s.token
       WHERE s.user_id = ? AND s.chat_id = ? AND s.captcha_completed = 0 AND s.expires_at > ?
         AND j.status = ?`,
      [Number(userId), Number(chatId), nowIso, RequestStatus.PENDING],
    );
    if (rows.length === 0) {
      return false;
    }
    for (const row of rows) {
      await expireVerificationSession(row.token);
      await rejectJoinRequest(row.token);
    }
    return true;
  } catch (error) {
    console.error("Error expiring pending sessions for user/chat:", error);
    return false;
  }
}

export async function purgeStaleRecords(
  retentionDays = 30,
): Promise<{
  sessions: number;
  join_requests: number;
}> {
  try {
    const cutoff = dateText(new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000));

    const sessions = await executeRun(
      `DELETE FROM verification_sessions WHERE created_time < ?`,
      [cutoff],
    );
    const joinRequests = await executeRun(
      `DELETE FROM join_requests WHERE request_time < ?`,
      [cutoff],
    );

    return { sessions: sessions.changes, join_requests: joinRequests.changes };
  } catch (error) {
    console.error("Error purging stale records:", error);
    return { sessions: 0, join_requests: 0 };
  }
}

export interface JoinRequestListFilters {
  status?: string;
  requestType?: string;
  chatId?: bigint;
  userId?: bigint;
  page?: number;
  pageSize?: number;
}

export async function listJoinRequests(
  filters: JoinRequestListFilters = {},
): Promise<{ rows: JoinRequestRow[]; total: number }> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(5, filters.pageSize ?? 20));
  const conditions: string[] = [];
  const params: SqlParam[] = [];

  if (filters.status) {
    conditions.push("status = ?");
    params.push(filters.status);
  }
  if (filters.requestType) {
    conditions.push("request_type = ?");
    params.push(filters.requestType);
  }
  if (filters.chatId !== undefined) {
    conditions.push("chat_id = ?");
    params.push(Number(filters.chatId));
  }
  if (filters.userId !== undefined) {
    conditions.push("user_id = ?");
    params.push(Number(filters.userId));
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const totalRow = await queryOne<{ count: number }>(
    `SELECT COUNT(id) AS count FROM join_requests ${where}`,
    params,
  );
  const total = toNumber(totalRow?.count ?? 0);
  const rows = await queryAll<Record<string, unknown>>(
    `SELECT * FROM join_requests ${where}
     ORDER BY request_time DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  return { rows: rows.map(mapJoinRequest), total };
}

/** 按群组统计待处理（pending）加群申请数：机器人测试页仿真屏群组列表的未读徽章数据源 */
export async function countPendingJoinRequestsByChat(): Promise<Map<string, number>> {
  const rows = await queryAll<{ chat_id: number | bigint; count: number }>(
    `SELECT chat_id, COUNT(id) AS count FROM join_requests
     WHERE status = 'pending'
     GROUP BY chat_id`,
  );
  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(String(toBigInt(row.chat_id)), toNumber(row.count));
  }
  return map;
}

export interface PendingCodeContext {
  session: VerificationSessionRow;
  joinRequest: JoinRequestRow;
  settings: GroupSettingsRow | null;
}

export async function getPendingCodeContext(
  userId: bigint,
): Promise<PendingCodeContext | null> {
  // v1.1.7：同时接受 code_api（外部卡密 API）与 code_self（机器人自生成验证码）会话 ——
  // 两种方式的用户交互完全一致（私聊回复/输入验证码），仅校验方不同
  const sessionRow = await queryOne<Record<string, unknown>>(
    `SELECT * FROM verification_sessions
     WHERE user_id = ? AND method IN ('code_api', 'code_self') AND captcha_completed = 0 AND expires_at > ?
     ORDER BY created_time DESC LIMIT 1`,
    [Number(userId), dateText(new Date())],
  );
  if (!sessionRow) return null;
  const session = mapSession(sessionRow);
  const joinRequest = await getJoinRequestByToken(session.token);
  if (!joinRequest || joinRequest.status !== RequestStatus.PENDING) return null;
  const settings = await getGroupSettings(session.chatId);
  return { session, joinRequest, settings };
}

/** 用户最近一条验证会话及其加群申请（不限状态，v1.1.4） */
export interface LatestVerificationContext {
  session: VerificationSessionRow;
  joinRequest: JoinRequestRow;
}

/**
 * 查用户最近一次验证会话与关联加群申请（无论完成/失效/待验证）。
 * v1.1.4 供 stateless-question 路径使用：用户回复的是验证提示消息但没有
 * 待验证会话时，按最近会话状态给出「已完成 / 已失效」的明确反馈，绝不静默。
 */
export async function getLatestVerificationContext(
  userId: bigint,
): Promise<LatestVerificationContext | null> {
  const sessionRow = await queryOne<Record<string, unknown>>(
    `SELECT * FROM verification_sessions
     WHERE user_id = ?
     ORDER BY created_time DESC LIMIT 1`,
    [Number(userId)],
  );
  if (!sessionRow) return null;
  const session = mapSession(sessionRow);
  const joinRequest = await getJoinRequestByToken(session.token);
  if (!joinRequest) return null;
  return { session, joinRequest };
}

export interface RoleUpsertInput {
  code: string;
  name: string;
  description?: string | null;
}

function mapRole(row: Record<string, unknown>): RoleRow {
  return {
    id: toBigInt(row.id),
    code: row.code as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    isBuiltin: toBoolean(row.is_builtin),
    createdTime: toDate(row.created_time),
  };
}

function mapPermission(row: Record<string, unknown>): PermissionRow {
  return {
    id: toBigInt(row.id),
    code: row.code as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    sortOrder: toNumber(row.sort_order ?? 0),
  };
}

function mapAdminUser(row: Record<string, unknown>): AdminUserRow {
  return {
    id: toBigInt(row.id),
    username: row.username as string,
    passwordHash: row.password_hash as string,
    displayName: (row.display_name as string | null) ?? null,
    roleId: toBigInt(row.role_id),
    status: row.status as string,
    createdTime: toDate(row.created_time),
    lastLoginTime: toDateOrNull(row.last_login_time),
  };
}

function mapMenu(row: Record<string, unknown>): MenuRow {
  return {
    id: toBigInt(row.id),
    parentId: toBigInt(row.parent_id ?? 0),
    title: row.title as string,
    path: row.path as string,
    icon: (row.icon as string | null) ?? null,
    sortOrder: toNumber(row.sort_order ?? 0),
    visible: toBoolean(row.visible),
    permissionCode: (row.permission_code as string | null) ?? null,
    status: toNumber(row.status ?? 1),
    createdTime: toDate(row.created_time),
    updatedTime: toDate(row.updated_time),
  };
}

function mapGroupSettings(row: Record<string, unknown>): GroupSettingsRow {
  return {
    chatId: toBigInt(row.chat_id),
    chatTitle: (row.chat_title as string | null) ?? null,
    method: row.method as string,
    methodId: toBigIntOrNull(row.method_id),
    timeoutSeconds: toNumber(row.timeout_seconds ?? 300),
    maxAttempts: toNumber(row.max_attempts ?? 3),
    promptText: (row.prompt_text as string) ?? "🔐 请回复本消息并输入验证码完成验证",
    successText: (row.success_text as string) ?? "✅ 验证成功，欢迎加入！",
    failureText: (row.failure_text as string) ?? "❌ 验证码错误，请重试。",
    enabled: toBoolean(row.enabled),
    privacyMode: row.privacy_mode === undefined ? true : toBoolean(row.privacy_mode),
    requireApproval: row.require_approval === undefined ? false : toBoolean(row.require_approval),
    createdTime: toDate(row.created_time),
    updatedTime: toDate(row.updated_time),
  };
}

function mapVerificationMethod(row: Record<string, unknown>): VerificationMethodRow {
  return {
    id: toBigInt(row.id),
    name: row.name as string,
    type: row.type as string,
    config: (row.config as string) ?? "{}",
    enabled: toBoolean(row.enabled),
    createdTime: toDate(row.created_time),
    updatedTime: toDate(row.updated_time),
  };
}

export async function listPermissions(): Promise<PermissionRow[]> {
  const rows = await queryAll<Record<string, unknown>>(
    `SELECT * FROM permissions ORDER BY sort_order, code`,
  );
  return rows.map(mapPermission);
}

export async function listRoles(): Promise<RoleRow[]> {
  const rows = await queryAll<Record<string, unknown>>(`SELECT * FROM roles ORDER BY id`);
  return rows.map(mapRole);
}

export async function getRole(id: bigint): Promise<RoleRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM roles WHERE id = ?`,
    [Number(id)],
  );
  return row ? mapRole(row) : null;
}

export async function createRole(input: RoleUpsertInput): Promise<RoleRow | null> {
  const result = await executeRun(
    `INSERT INTO roles (code, name, description, is_builtin) VALUES (?, ?, ?, 0)`,
    [input.code, input.name, input.description ?? null],
  );
  if (result.changes !== 1) return null;
  return getRole(BigInt(result.lastInsertRowid));
}

export async function updateRole(
  id: bigint,
  fields: { code?: string; name?: string; description?: string | null },
): Promise<RoleRow | null> {
  const sets: string[] = [];
  const params: SqlParam[] = [];
  if (fields.code !== undefined) {
    sets.push("code = ?");
    params.push(fields.code);
  }
  if (fields.name !== undefined) {
    sets.push("name = ?");
    params.push(fields.name);
  }
  if (fields.description !== undefined) {
    sets.push("description = ?");
    params.push(fields.description);
  }
  if (sets.length === 0) return getRole(id);
  params.push(Number(id));
  await executeRun(`UPDATE roles SET ${sets.join(", ")} WHERE id = ? AND is_builtin = 0`, params);
  return getRole(id);
}

export async function deleteRole(id: bigint): Promise<boolean> {
  const role = await getRole(id);
  if (!role || role.isBuiltin) return false;
  await executeRun(`DELETE FROM role_permissions WHERE role_id = ?`, [Number(id)]);
  await executeRun(`UPDATE admin_users SET role_id = 2 WHERE role_id = ?`, [Number(id)]);
  await executeRun(`DELETE FROM roles WHERE id = ?`, [Number(id)]);
  return true;
}

export async function getRolePermissionCodes(roleId: bigint): Promise<string[]> {
  const rows = await queryAll<{ code: string }>(
    `SELECT p.code FROM permissions p
     JOIN role_permissions rp ON rp.permission_id = p.id
     WHERE rp.role_id = ?`,
    [Number(roleId)],
  );
  return rows.map((row) => row.code);
}

export async function setRolePermissions(
  roleId: bigint,
  codes: string[],
): Promise<void> {
  await executeRun(`DELETE FROM role_permissions WHERE role_id = ?`, [Number(roleId)]);
  if (codes.length === 0) return;
  const placeholders = codes.map(() => "?").join(", ");
  const permissionRows = await queryAll<{ id: number }>(
    `SELECT id FROM permissions WHERE code IN (${placeholders})`,
    codes,
  );
  for (const row of permissionRows) {
    await executeRun(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)`,
      [Number(roleId), Number(row.id)],
    );
  }
}

export async function listAdminUsers(): Promise<(AdminUserRow & { roleName: string; roleCode: string })[]> {
  const rows = await queryAll<Record<string, unknown>>(
    `SELECT u.*, r.name AS role_name, r.code AS role_code
     FROM admin_users u LEFT JOIN roles r ON r.id = u.role_id
     ORDER BY u.id`,
  );
  return rows.map((row) => ({
    ...mapAdminUser(row),
    roleName: (row.role_name as string) ?? "",
    roleCode: (row.role_code as string) ?? "",
  }));
}

export async function getAdminUserByUsername(
  username: string,
): Promise<AdminUserRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM admin_users WHERE username = ?`,
    [username],
  );
  return row ? mapAdminUser(row) : null;
}

export async function getAdminUserById(id: bigint): Promise<AdminUserRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM admin_users WHERE id = ?`,
    [Number(id)],
  );
  return row ? mapAdminUser(row) : null;
}

export async function createAdminUser(input: {
  username: string;
  passwordHash: string;
  displayName?: string | null;
  roleId: bigint;
}): Promise<AdminUserRow | null> {
  const result = await executeRun(
    `INSERT INTO admin_users (username, password_hash, display_name, role_id, status)
     VALUES (?, ?, ?, ?, 'active')`,
    [input.username, input.passwordHash, input.displayName ?? null, Number(input.roleId)],
  );
  if (result.changes !== 1) return null;
  return getAdminUserById(BigInt(result.lastInsertRowid));
}

export async function updateAdminUser(
  id: bigint,
  fields: {
    displayName?: string | null;
    roleId?: bigint;
    status?: string;
    passwordHash?: string;
  },
): Promise<AdminUserRow | null> {
  const sets: string[] = [];
  const params: SqlParam[] = [];
  if (fields.displayName !== undefined) {
    sets.push("display_name = ?");
    params.push(fields.displayName);
  }
  if (fields.roleId !== undefined) {
    sets.push("role_id = ?");
    params.push(Number(fields.roleId));
  }
  if (fields.status !== undefined) {
    sets.push("status = ?");
    params.push(fields.status);
  }
  if (fields.passwordHash !== undefined) {
    sets.push("password_hash = ?");
    params.push(fields.passwordHash);
  }
  if (sets.length > 0) {
    params.push(Number(id));
    await executeRun(`UPDATE admin_users SET ${sets.join(", ")} WHERE id = ?`, params);
  }
  return getAdminUserById(id);
}

export async function deleteAdminUser(id: bigint): Promise<boolean> {
  const user = await getAdminUserById(id);
  if (!user || user.username === "admin") return false;
  await executeRun(`DELETE FROM admin_sessions WHERE user_id = ?`, [Number(id)]);
  await executeRun(`DELETE FROM admin_users WHERE id = ?`, [Number(id)]);
  return true;
}

export async function touchAdminLogin(id: bigint): Promise<void> {
  await executeRun(`UPDATE admin_users SET last_login_time = ? WHERE id = ?`, [
    dateText(new Date()),
    Number(id),
  ]);
}

export async function createAdminSession(input: {
  userId: bigint;
  tokenHash: string;
  expiresAt: Date;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  await executeRun(
    `INSERT INTO admin_sessions (user_id, token_hash, expires_at, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?)`,
    [
      Number(input.userId),
      input.tokenHash,
      dateText(input.expiresAt),
      input.ipAddress ?? null,
      input.userAgent ?? null,
    ],
  );
}

export async function getAdminSession(
  tokenHash: string,
): Promise<AdminSessionContext | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT s.id AS session_id, s.user_id, s.token_hash, s.expires_at, s.ip_address, s.user_agent,
            u.id AS admin_id, u.username, u.password_hash, u.display_name, u.role_id, u.status,
            u.created_time AS user_created_time, u.last_login_time,
            r.name AS role_name, r.code AS role_code
     FROM admin_sessions s
     JOIN admin_users u ON u.id = s.user_id
     LEFT JOIN roles r ON r.id = u.role_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
    [tokenHash, dateText(new Date())],
  );
  if (!row) return null;
  if (row.status !== "active") return null;
  const roleId = toBigInt(row.role_id);
  const [permissions, role] = await Promise.all([
    getRolePermissionCodes(roleId),
    getRole(roleId),
  ]);
  return {
    session: {
      id: toBigInt(row.session_id),
      userId: toBigInt(row.user_id),
      tokenHash: row.token_hash as string,
      expiresAt: toDate(row.expires_at),
      ipAddress: (row.ip_address as string | null) ?? null,
      userAgent: (row.user_agent as string | null) ?? null,
    },
    user: {
      ...mapAdminUser({
        id: row.admin_id,
        username: row.username,
        password_hash: row.password_hash,
        display_name: row.display_name,
        role_id: row.role_id,
        status: row.status,
        created_time: row.user_created_time,
        last_login_time: row.last_login_time,
      }),
      roleName: (row.role_name as string) ?? "",
      roleCode: (row.role_code as string) ?? "",
    },
    permissions: role?.isBuiltin ? permissions : permissions,
  };
}

export async function deleteAdminSession(tokenHash: string): Promise<void> {
  await executeRun(`DELETE FROM admin_sessions WHERE token_hash = ?`, [tokenHash]);
}

export async function deleteExpiredAdminSessions(): Promise<number> {
  const result = await executeRun(
    `DELETE FROM admin_sessions WHERE expires_at < ?`,
    [dateText(new Date())],
  );
  return result.changes;
}

export async function listMenus(options?: {
  visibleOnly?: boolean;
}): Promise<MenuRow[]> {
  const conditions: string[] = ["status = 1"];
  if (options?.visibleOnly) conditions.push("visible = 1");
  const rows = await queryAll<Record<string, unknown>>(
    `SELECT * FROM menus WHERE ${conditions.join(" AND ")} ORDER BY sort_order, id`,
  );
  return rows.map(mapMenu);
}

export async function getMenu(id: bigint): Promise<MenuRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM menus WHERE id = ?`,
    [Number(id)],
  );
  return row ? mapMenu(row) : null;
}

export interface MenuUpsertInput {
  parentId?: bigint;
  title: string;
  path: string;
  icon?: string | null;
  sortOrder?: number;
  visible?: boolean;
  permissionCode?: string | null;
  status?: number;
}

export async function createMenu(input: MenuUpsertInput): Promise<MenuRow | null> {
  const result = await executeRun(
    `INSERT INTO menus (parent_id, title, path, icon, sort_order, visible, permission_code, status, created_time, updated_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(input.parentId ?? 0),
      input.title,
      input.path,
      input.icon ?? null,
      input.sortOrder ?? 0,
      input.visible === false ? 0 : 1,
      input.permissionCode ?? null,
      input.status ?? 1,
      dateText(new Date()),
      dateText(new Date()),
    ],
  );
  if (result.changes !== 1) return null;
  return getMenu(BigInt(result.lastInsertRowid));
}

export async function updateMenu(
  id: bigint,
  input: MenuUpsertInput,
): Promise<MenuRow | null> {
  await executeRun(
    `UPDATE menus
     SET parent_id = ?, title = ?, path = ?, icon = ?, sort_order = ?, visible = ?, permission_code = ?, status = ?, updated_time = ?
     WHERE id = ?`,
    [
      Number(input.parentId ?? 0),
      input.title,
      input.path,
      input.icon ?? null,
      input.sortOrder ?? 0,
      input.visible === false ? 0 : 1,
      input.permissionCode ?? null,
      input.status ?? 1,
      dateText(new Date()),
      Number(id),
    ],
  );
  return getMenu(id);
}

export async function deleteMenu(id: bigint): Promise<boolean> {
  // 递归收集整棵子树（菜单表中同时存在多层嵌套时也要全部删除，避免孤儿节点）
  const rows = await queryAll<{ id: number; parent_id: number }>(
    `SELECT id, parent_id FROM menus`,
  );
  const childrenMap = new Map<number, number[]>();
  for (const row of rows) {
    const bucket = childrenMap.get(row.parent_id) ?? [];
    bucket.push(row.id);
    childrenMap.set(row.parent_id, bucket);
  }
  const targets: number[] = [];
  const stack = [Number(id)];
  while (stack.length > 0) {
    const current = stack.pop() as number;
    targets.push(current);
    stack.push(...(childrenMap.get(current) ?? []));
  }
  const placeholders = targets.map(() => "?").join(", ");
  await executeRun(`DELETE FROM menus WHERE id IN (${placeholders})`, targets);
  return true;
}

const GROUP_SETTINGS_CACHE_KEY = "group-settings";
const GROUP_SETTINGS_CACHE_TTL_SECONDS = 30;

type GroupSettingsCache = Record<string, GroupSettingsRow | null>;

async function loadGroupSettingsCache(): Promise<GroupSettingsCache> {
  // v1.0.8 修复：v1.0.7 此处误传空 loader（async () => ({})），导致 getGroupSettings
  // 永远返回 null，真实群组验证流程无法读取 method/method_id 等配置。
  // 缓存层只存放 JSON 安全的原始行（bigint 日期等在读取时再映射）。
  const rawCache = await cachedJson<Record<string, Record<string, unknown>>>(
    GROUP_SETTINGS_CACHE_KEY,
    GROUP_SETTINGS_CACHE_TTL_SECONDS,
    async () => {
      const rows = await queryAll<Record<string, unknown>>(`SELECT * FROM group_settings`);
      const cache: Record<string, Record<string, unknown>> = {};
      for (const row of rows) {
        cache[String(row.chat_id)] = row;
      }
      return cache;
    },
  );
  const mapped: GroupSettingsCache = {};
  for (const [chatId, row] of Object.entries(rawCache)) {
    try {
      mapped[chatId] = mapGroupSettings(row);
    } catch {
      /* skip malformed cached rows */
    }
  }
  return mapped;
}

export async function listGroupSettings(): Promise<GroupSettingsRow[]> {
  const rows = await queryAll<Record<string, unknown>>(
    `SELECT * FROM group_settings ORDER BY chat_id`,
  );
  return rows.map(mapGroupSettings);
}

export async function getGroupSettings(
  chatId: bigint,
): Promise<GroupSettingsRow | null> {
  const cache = await loadGroupSettingsCache();
  return cache[String(chatId)] ?? null;
}

export async function upsertGroupSettings(
  chatId: bigint,
  input: {
    chatTitle?: string | null;
    method?: string;
    methodId?: bigint | null;
    timeoutSeconds?: number;
    maxAttempts?: number;
    promptText?: string;
    successText?: string;
    failureText?: string;
    enabled?: boolean;
    privacyMode?: boolean;
    /** v1.1.9 加群需要管理员审核；undefined = 不改动现有值 */
    requireApproval?: boolean;
  },
): Promise<void> {
  // requireApproval === undefined 语义为「不改动现有值」。
  // 该列是 NOT NULL，SQLite 在 INSERT 阶段即校验约束（不会等 COALESCE 兜底），
  // 因此必须先读出现值（无行则 false），绝不允许绑定 null。
  let requireApprovalValue = input.requireApproval;
  if (requireApprovalValue === undefined) {
    const existing = await getGroupSettings(chatId);
    requireApprovalValue = existing ? existing.requireApproval : false;
  }

  await executeRun(
    `INSERT INTO group_settings
       (chat_id, chat_title, method, method_id, timeout_seconds, max_attempts, prompt_text, success_text, failure_text, enabled, privacy_mode, require_approval, created_time, updated_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       chat_title = COALESCE(excluded.chat_title, group_settings.chat_title),
       method = COALESCE(excluded.method, group_settings.method),
       method_id = excluded.method_id,
       timeout_seconds = COALESCE(excluded.timeout_seconds, group_settings.timeout_seconds),
       max_attempts = COALESCE(excluded.max_attempts, group_settings.max_attempts),
       prompt_text = COALESCE(excluded.prompt_text, group_settings.prompt_text),
       success_text = COALESCE(excluded.success_text, group_settings.success_text),
       failure_text = COALESCE(excluded.failure_text, group_settings.failure_text),
       enabled = COALESCE(excluded.enabled, group_settings.enabled),
       privacy_mode = COALESCE(excluded.privacy_mode, group_settings.privacy_mode),
       require_approval = excluded.require_approval,
       updated_time = excluded.updated_time`,
    [
      Number(chatId),
      input.chatTitle ?? null,
      input.method ?? "captcha",
      input.methodId === undefined || input.methodId === null ? null : Number(input.methodId),
      input.timeoutSeconds ?? 300,
      input.maxAttempts ?? 3,
      input.promptText ?? "🔐 请回复本消息并输入验证码完成验证",
      input.successText ?? "✅ 验证成功，欢迎加入！",
      input.failureText ?? "❌ 验证码错误，请重试。",
      input.enabled === false ? 0 : 1,
      input.privacyMode === false ? 0 : 1,
      requireApprovalValue ? 1 : 0,
      dateText(new Date()),
      dateText(new Date()),
    ],
  );
  await invalidateCache(GROUP_SETTINGS_CACHE_KEY);
}

export async function deleteGroupSettings(chatId: bigint): Promise<boolean> {
  const result = await executeRun(
    `DELETE FROM group_settings WHERE chat_id = ?`,
    [Number(chatId)],
  );
  await invalidateCache(GROUP_SETTINGS_CACHE_KEY);
  return result.changes > 0;
}

export async function listVerificationMethods(): Promise<VerificationMethodRow[]> {
  const rows = await queryAll<Record<string, unknown>>(
    `SELECT * FROM verification_methods ORDER BY id`,
  );
  return rows.map(mapVerificationMethod);
}

export async function getVerificationMethod(
  id: bigint,
): Promise<VerificationMethodRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM verification_methods WHERE id = ?`,
    [Number(id)],
  );
  return row ? mapVerificationMethod(row) : null;
}

/** 按名称精确查找验证方式（verification_methods.name 全局唯一） */
export async function getVerificationMethodByName(
  name: string,
): Promise<VerificationMethodRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM verification_methods WHERE name = ?`,
    [name],
  );
  return row ? mapVerificationMethod(row) : null;
}

export async function createVerificationMethod(input: {
  name: string;
  type?: string;
  config?: string;
  enabled?: boolean;
}): Promise<VerificationMethodRow | null> {
  const result = await executeRun(
    `INSERT INTO verification_methods (name, type, config, enabled, created_time, updated_time)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      input.name,
      input.type ?? "code_api",
      input.config ?? "{}",
      input.enabled === false ? 0 : 1,
      dateText(new Date()),
      dateText(new Date()),
    ],
  );
  if (result.changes !== 1) return null;
  return getVerificationMethod(BigInt(result.lastInsertRowid));
}

export async function updateVerificationMethod(
  id: bigint,
  input: { name?: string; type?: string; config?: string; enabled?: boolean },
): Promise<VerificationMethodRow | null> {
  const sets: string[] = [];
  const params: SqlParam[] = [];
  if (input.name !== undefined) {
    sets.push("name = ?");
    params.push(input.name);
  }
  if (input.type !== undefined) {
    sets.push("type = ?");
    params.push(input.type);
  }
  if (input.config !== undefined) {
    sets.push("config = ?");
    params.push(input.config);
  }
  if (input.enabled !== undefined) {
    sets.push("enabled = ?");
    params.push(input.enabled ? 1 : 0);
  }
  if (sets.length > 0) {
    sets.push("updated_time = ?");
    params.push(dateText(new Date()));
    params.push(Number(id));
    await executeRun(
      `UPDATE verification_methods SET ${sets.join(", ")} WHERE id = ?`,
      params,
    );
  }
  return getVerificationMethod(id);
}

export async function deleteVerificationMethod(id: bigint): Promise<boolean> {
  await executeRun(
    `UPDATE group_settings SET method = 'captcha', method_id = NULL WHERE method_id = ?`,
    [Number(id)],
  );
  await invalidateCache(GROUP_SETTINGS_CACHE_KEY);
  const result = await executeRun(
    `DELETE FROM verification_methods WHERE id = ?`,
    [Number(id)],
  );
  return result.changes > 0;
}

export async function recordOperationLog(input: {
  adminId?: bigint | null;
  adminUsername?: string | null;
  action: string;
  target?: string | null;
  detail?: string | null;
  ipAddress?: string | null;
}): Promise<void> {
  await executeRun(
    `INSERT INTO operation_logs (admin_id, admin_username, action, target, detail, ip_address)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      input.adminId === undefined || input.adminId === null ? null : Number(input.adminId),
      input.adminUsername ?? null,
      input.action,
      input.target ?? null,
      input.detail ?? null,
      input.ipAddress ?? null,
    ],
  );
}

export async function listOperationLogs(options?: {
  page?: number;
  pageSize?: number;
}): Promise<{ rows: OperationLogRow[]; total: number }> {
  const page = Math.max(1, options?.page ?? 1);
  const pageSize = Math.min(100, Math.max(5, options?.pageSize ?? 20));
  const totalRow = await queryOne<{ count: number }>(
    `SELECT COUNT(id) AS count FROM operation_logs`,
  );
  const total = toNumber(totalRow?.count ?? 0);
  const rows = await queryAll<Record<string, unknown>>(
    `SELECT * FROM operation_logs ORDER BY created_time DESC, id DESC LIMIT ? OFFSET ?`,
    [pageSize, (page - 1) * pageSize],
  );
  return {
    rows: rows.map((row) => ({
      id: toBigInt(row.id),
      adminId: toBigIntOrNull(row.admin_id),
      adminUsername: (row.admin_username as string | null) ?? null,
      action: row.action as string,
      target: (row.target as string | null) ?? null,
      detail: (row.detail as string | null) ?? null,
      ipAddress: (row.ip_address as string | null) ?? null,
      createdTime: toDate(row.created_time),
    })),
    total,
  };
}

export async function getAppSetting(key: string): Promise<string | null> {
  const row = await queryOne<{ value: string }>(
    `SELECT value FROM app_settings WHERE key = ?`,
    [key],
  );
  return row ? row.value : null;
}

export async function getAllAppSettings(): Promise<Record<string, string>> {
  const rows = await queryAll<{ key: string; value: string }>(
    `SELECT key, value FROM app_settings`,
  );
  const settings: Record<string, string> = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  return settings;
}

export async function setAppSetting(key: string, value: string): Promise<void> {
  await executeRun(
    `INSERT INTO app_settings (key, value, updated_time) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_time = excluded.updated_time`,
    [key, value, dateText(new Date())],
  );
  await invalidateCache(APP_SETTINGS_CACHE_KEY);
}

export async function deleteAppSetting(key: string): Promise<void> {
  await executeRun(`DELETE FROM app_settings WHERE key = ?`, [key]);
  await invalidateCache(APP_SETTINGS_CACHE_KEY);
}

export const APP_SETTINGS_CACHE_KEY = "app-settings";

export async function getCachedAppSettings(): Promise<Record<string, string>> {
  return cachedJson<Record<string, string>>(
    APP_SETTINGS_CACHE_KEY,
    15,
    getAllAppSettings,
  );
}

export interface BotRow {
  id: bigint;
  name: string;
  token: string;
  username: string | null;
  enabled: boolean;
  config: string;
  menuConfig: string;
  menuText: string;
  createdTime: Date;
  updatedTime: Date;
}

function mapBot(row: Record<string, unknown>): BotRow {
  return {
    id: toBigInt(row.id),
    name: row.name as string,
    token: (row.token as string) ?? "",
    username: (row.username as string | null) ?? null,
    enabled: toNumber(row.enabled) === 1,
    config: (row.config as string) ?? "{}",
    menuConfig: (row.menu_config as string) ?? "{}",
    menuText: (row.menu_text as string) ?? "",
    createdTime: toDate(row.created_time),
    updatedTime: toDate(row.updated_time),
  };
}

export async function listBots(): Promise<BotRow[]> {
  const rows = await queryAll<Record<string, unknown>>(
    `SELECT * FROM bots ORDER BY id`,
  );
  return rows.map(mapBot);
}

export async function listEnabledBots(): Promise<BotRow[]> {
  const rows = await queryAll<Record<string, unknown>>(
    `SELECT * FROM bots WHERE enabled = 1 ORDER BY id`,
  );
  return rows.map(mapBot);
}

export async function getBot(id: bigint): Promise<BotRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM bots WHERE id = ?`,
    [Number(id)],
  );
  return row ? mapBot(row) : null;
}

export async function createBotRecord(input: {
  name: string;
  token: string;
  username?: string | null;
  enabled?: boolean;
  config?: string;
  menuConfig?: string;
  menuText?: string;
}): Promise<BotRow | null> {
  const result = await executeRun(
    `INSERT INTO bots (name, token, username, enabled, config, menu_config, menu_text, created_time, updated_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.name,
      input.token,
      input.username ?? null,
      input.enabled === false ? 0 : 1,
      input.config ?? "{}",
      input.menuConfig ?? "{}",
      input.menuText ?? "📋 请使用下方菜单：",
      dateText(new Date()),
      dateText(new Date()),
    ],
  );
  if (result.changes !== 1) return null;
  return getBot(BigInt(result.lastInsertRowid));
}

export async function updateBotRecord(
  id: bigint,
  input: {
    name?: string;
    token?: string;
    username?: string | null;
    enabled?: boolean;
    config?: string;
    menuConfig?: string;
    menuText?: string;
  },
): Promise<BotRow | null> {
  const sets: string[] = [];
  const params: SqlParam[] = [];
  if (input.name !== undefined) {
    sets.push("name = ?");
    params.push(input.name);
  }
  if (input.token !== undefined) {
    sets.push("token = ?");
    params.push(input.token);
  }
  if (input.username !== undefined) {
    sets.push("username = ?");
    params.push(input.username);
  }
  if (input.enabled !== undefined) {
    sets.push("enabled = ?");
    params.push(input.enabled ? 1 : 0);
  }
  if (input.config !== undefined) {
    sets.push("config = ?");
    params.push(input.config);
  }
  if (input.menuConfig !== undefined) {
    sets.push("menu_config = ?");
    params.push(input.menuConfig);
  }
  if (input.menuText !== undefined) {
    sets.push("menu_text = ?");
    params.push(input.menuText);
  }
  if (sets.length > 0) {
    sets.push("updated_time = ?");
    params.push(dateText(new Date()));
    params.push(Number(id));
    await executeRun(`UPDATE bots SET ${sets.join(", ")} WHERE id = ?`, params);
  }
  return getBot(id);
}

export async function deleteBotRecord(id: bigint): Promise<boolean> {
  await executeRun(`DELETE FROM group_bot_admins WHERE bot_id = ?`, [Number(id)]);
  const result = await executeRun(`DELETE FROM bots WHERE id = ?`, [Number(id)]);
  return result.changes > 0;
}

export interface DeveloperAccountRow {
  id: bigint;
  phone: string;
  apiId: string;
  apiHash: string;
  remark: string | null;
  createdTime: Date;
  updatedTime: Date;
}

function mapDeveloperAccount(row: Record<string, unknown>): DeveloperAccountRow {
  return {
    id: toBigInt(row.id),
    phone: (row.phone as string) ?? "",
    apiId: (row.api_id as string) ?? "",
    apiHash: (row.api_hash as string) ?? "",
    remark: (row.remark as string | null) ?? null,
    createdTime: toDate(row.created_time),
    updatedTime: toDate(row.updated_time),
  };
}

export async function listDeveloperAccounts(): Promise<DeveloperAccountRow[]> {
  const rows = await queryAll<Record<string, unknown>>(
    `SELECT * FROM developer_accounts ORDER BY id`,
  );
  return rows.map(mapDeveloperAccount);
}

export async function getDeveloperAccount(id: bigint): Promise<DeveloperAccountRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM developer_accounts WHERE id = ?`,
    [Number(id)],
  );
  return row ? mapDeveloperAccount(row) : null;
}

export async function createDeveloperAccount(input: {
  phone: string;
  apiId: string;
  apiHash: string;
  remark?: string | null;
}): Promise<DeveloperAccountRow | null> {
  const result = await executeRun(
    `INSERT INTO developer_accounts (phone, api_id, api_hash, remark, created_time, updated_time)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      input.phone,
      input.apiId,
      input.apiHash,
      input.remark ?? null,
      dateText(new Date()),
      dateText(new Date()),
    ],
  );
  if (result.changes !== 1) return null;
  return getDeveloperAccount(BigInt(result.lastInsertRowid));
}

export async function updateDeveloperAccount(
  id: bigint,
  input: { phone?: string; apiId?: string; apiHash?: string; remark?: string | null },
): Promise<DeveloperAccountRow | null> {
  const sets: string[] = [];
  const params: SqlParam[] = [];
  if (input.phone !== undefined) {
    sets.push("phone = ?");
    params.push(input.phone);
  }
  if (input.apiId !== undefined) {
    sets.push("api_id = ?");
    params.push(input.apiId);
  }
  if (input.apiHash !== undefined) {
    sets.push("api_hash = ?");
    params.push(input.apiHash);
  }
  if (input.remark !== undefined) {
    sets.push("remark = ?");
    params.push(input.remark);
  }
  if (sets.length > 0) {
    sets.push("updated_time = ?");
    params.push(dateText(new Date()));
    params.push(Number(id));
    await executeRun(`UPDATE developer_accounts SET ${sets.join(", ")} WHERE id = ?`, params);
  }
  return getDeveloperAccount(id);
}

export async function deleteDeveloperAccount(id: bigint): Promise<boolean> {
  const result = await executeRun(`DELETE FROM developer_accounts WHERE id = ?`, [Number(id)]);
  return result.changes > 0;
}

export interface GroupBotAdminRow {
  id: bigint;
  botId: bigint;
  chatId: bigint;
  rights: string;
  status: string;
  createdTime: Date;
  updatedTime: Date;
}

function mapGroupBotAdmin(row: Record<string, unknown>): GroupBotAdminRow {
  return {
    id: toBigInt(row.id),
    botId: toBigInt(row.bot_id),
    chatId: toBigInt(row.chat_id),
    rights: (row.rights as string) ?? "{}",
    status: (row.status as string) ?? "active",
    createdTime: toDate(row.created_time),
    updatedTime: toDate(row.updated_time),
  };
}

export async function listGroupBotAdmins(chatId?: bigint): Promise<GroupBotAdminRow[]> {
  const rows = chatId === undefined
    ? await queryAll<Record<string, unknown>>(`SELECT * FROM group_bot_admins ORDER BY id`)
    : await queryAll<Record<string, unknown>>(
        `SELECT * FROM group_bot_admins WHERE chat_id = ? ORDER BY id`,
        [Number(chatId)],
      );
  return rows.map(mapGroupBotAdmin);
}

export async function upsertGroupBotAdmin(input: {
  botId: bigint;
  chatId: bigint;
  rights: string;
  status?: string;
}): Promise<void> {
  await executeRun(
    `INSERT INTO group_bot_admins (bot_id, chat_id, rights, status, created_time, updated_time)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(bot_id, chat_id) DO UPDATE SET
       rights = excluded.rights,
       status = excluded.status,
       updated_time = excluded.updated_time`,
    [
      Number(input.botId),
      Number(input.chatId),
      input.rights,
      input.status ?? "active",
      dateText(new Date()),
      dateText(new Date()),
    ],
  );
}

export async function deleteGroupBotAdmin(id: bigint): Promise<boolean> {
  const result = await executeRun(`DELETE FROM group_bot_admins WHERE id = ?`, [Number(id)]);
  return result.changes > 0;
}

/** 按 chat_id 删除该群组的全部机器人关联行（group_bot_admins），返回删除行数。
 *  用于删除群组配置时彻底清理关联，以及同步确认群已失效后移除历史链接。 */
export async function deleteGroupBotAdminsByChat(chatId: bigint): Promise<number> {
  const result = await executeRun(`DELETE FROM group_bot_admins WHERE chat_id = ?`, [Number(chatId)]);
  return result.changes;
}

export async function getGroupBotAdmin(id: bigint): Promise<GroupBotAdminRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM group_bot_admins WHERE id = ?`,
    [Number(id)],
  );
  return row ? mapGroupBotAdmin(row) : null;
}

export async function getGroupBotAdminByBotAndChat(botId: bigint, chatId: bigint): Promise<GroupBotAdminRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM group_bot_admins WHERE bot_id = ? AND chat_id = ?`,
    [Number(botId), Number(chatId)],
  );
  return row ? mapGroupBotAdmin(row) : null;
}

/** 群 → 受理 bot 绑定（bots 表中的启用 bot 及其 token，供审批/私聊等跨 bot 操作使用） */
export interface ChatBotBinding {
  botId: bigint;
  token: string;
}

/**
 * 按群查找受理 bot（FIX-B 跨 token 审批缺陷修复）：
 * group_bot_admins × bots 联查，取该群 status='active' 且 bot enabled=1、token 非空的
 * 绑定中 updated_time 最新的一条。无绑定时返回 null（由调用方回落主 bot）。
 */
export async function getActiveBotForChat(chatId: bigint): Promise<ChatBotBinding | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT b.id, b.token
     FROM group_bot_admins g
     JOIN bots b ON b.id = g.bot_id
     WHERE g.chat_id = ? AND g.status = 'active' AND b.enabled = 1 AND b.token <> ''
     ORDER BY g.updated_time DESC
     LIMIT 1`,
    [Number(chatId)],
  );
  return row ? { botId: toBigInt(row.id), token: (row.token as string) ?? "" } : null;
}

// ============ 指令库（内置指令 / 自定义指令） ============

export type BotCommandType = "builtin" | "custom";

export interface BotCommandRow {
  id: bigint;
  type: BotCommandType;
  name: string;
  description: string;
  intro: string;
  enabled: boolean;
  sortOrder: number;
  createdTime: Date;
  updatedTime: Date;
}

function mapBotCommand(row: Record<string, unknown>): BotCommandRow {
  return {
    id: toBigInt(row.id),
    type: (row.type as BotCommandType) ?? "builtin",
    name: (row.name as string) ?? "",
    description: (row.description as string) ?? "",
    intro: (row.intro as string) ?? "",
    enabled: toBoolean(row.enabled),
    sortOrder: toNumber(row.sort_order ?? 0),
    createdTime: toDate(row.created_time),
    updatedTime: toDate(row.updated_time),
  };
}

export interface BotCommandPage {
  rows: BotCommandRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** 分页查询指令库，type=builtin 内置指令 / custom 自定义指令，每页默认 20 条 */
export async function listBotCommands(options: {
  type: BotCommandType;
  page?: number;
  pageSize?: number;
  enabledOnly?: boolean;
}): Promise<BotCommandPage> {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(options.pageSize ?? 20)));
  const where: string[] = [`type = ?`];
  const params: (string | number)[] = [options.type];
  if (options.enabledOnly) {
    where.push(`enabled = 1`);
  }
  const whereSql = where.join(" AND ");
  const totalRow = await queryOne<{ total: number }>(
    `SELECT COUNT(*) AS total FROM bot_commands WHERE ${whereSql}`,
    params,
  );
  const total = Number(totalRow?.total ?? 0);
  const rows = await queryAll<Record<string, unknown>>(
    `SELECT * FROM bot_commands WHERE ${whereSql}
     ORDER BY sort_order, id LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  return {
    rows: rows.map(mapBotCommand),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export async function getBotCommand(id: bigint): Promise<BotCommandRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM bot_commands WHERE id = ?`,
    [Number(id)],
  );
  return row ? mapBotCommand(row) : null;
}

export async function createBotCommand(input: {
  type: BotCommandType;
  name: string;
  description: string;
  intro?: string;
  enabled?: boolean;
  sortOrder?: number;
}): Promise<bigint | null> {
  const result = await executeRun(
    `INSERT INTO bot_commands (type, name, description, intro, enabled, sort_order, created_time, updated_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.type,
      input.name,
      input.description,
      input.intro ?? "",
      input.enabled === false ? 0 : 1,
      input.sortOrder ?? 0,
      dateText(new Date()),
      dateText(new Date()),
    ],
  );
  return result.lastInsertRowid ? BigInt(result.lastInsertRowid) : null;
}

export async function updateBotCommand(
  id: bigint,
  input: {
    name?: string;
    description?: string;
    intro?: string;
    enabled?: boolean;
    sortOrder?: number;
  },
): Promise<boolean> {
  const result = await executeRun(
    `UPDATE bot_commands SET
       name = COALESCE(?, name),
       description = COALESCE(?, description),
       intro = COALESCE(?, intro),
       enabled = COALESCE(?, enabled),
       sort_order = COALESCE(?, sort_order),
       updated_time = ?
     WHERE id = ?`,
    [
      input.name ?? null,
      input.description ?? null,
      input.intro ?? null,
      input.enabled === undefined ? null : input.enabled ? 1 : 0,
      input.sortOrder ?? null,
      dateText(new Date()),
      Number(id),
    ],
  );
  return result.changes > 0;
}

export async function deleteBotCommand(id: bigint): Promise<boolean> {
  const result = await executeRun(`DELETE FROM bot_commands WHERE id = ?`, [Number(id)]);
  return result.changes > 0;
}

/**
 * ↑↓ 排序：与相邻的同类型指令交换 sort_order（按 sort_order, id 确定邻接关系）。
 * 若两者排序值相等（如默认都为 0），则直接给当前行赋 neighbor±1，保证一定交换位置。
 */
export async function moveBotCommand(
  id: bigint,
  type: BotCommandType,
  direction: "up" | "down",
): Promise<boolean> {
  const current = await getBotCommand(id);
  if (!current) return false;
  const neighborRow =
    direction === "up"
      ? await queryOne<Record<string, unknown>>(
          `SELECT * FROM bot_commands
           WHERE type = ? AND (sort_order < ? OR (sort_order = ? AND id < ?))
           ORDER BY sort_order DESC, id DESC LIMIT 1`,
          [type, current.sortOrder, current.sortOrder, Number(id)],
        )
      : await queryOne<Record<string, unknown>>(
          `SELECT * FROM bot_commands
           WHERE type = ? AND (sort_order > ? OR (sort_order = ? AND id > ?))
           ORDER BY sort_order ASC, id ASC LIMIT 1`,
          [type, current.sortOrder, current.sortOrder, Number(id)],
        );
  if (!neighborRow) return false;
  const neighbor = mapBotCommand(neighborRow);
  if (neighbor.sortOrder === current.sortOrder) {
    // 相等排序值：直接越过对方（保证视觉位置交换）
    const shifted = direction === "up" ? current.sortOrder - 1 : current.sortOrder + 1;
    await updateBotCommand(id, { sortOrder: shifted });
    await updateBotCommand(neighbor.id, { sortOrder: current.sortOrder });
  } else {
    await updateBotCommand(id, { sortOrder: neighbor.sortOrder });
    await updateBotCommand(neighbor.id, { sortOrder: current.sortOrder });
  }
  return true;
}

/** 查询机器人指令菜单选中的指令（返回 Telegram BotCommand 结构），供 setMyCommands 同步 */
export async function listBotCommandsByIds(
  ids: bigint[],
): Promise<BotCommandRow[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = await queryAll<Record<string, unknown>>(
    `SELECT * FROM bot_commands WHERE id IN (${placeholders}) AND enabled = 1
     ORDER BY sort_order, id`,
    ids.map((id) => Number(id)),
  );
  return rows.map(mapBotCommand);
}
