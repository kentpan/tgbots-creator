import { executeRun, queryAll, queryOne, type SqlParam } from "@/database/client";

// ============ mirror 访问控制（验证绑定链路） ============

/**
 * 用户是否曾通过本系统任一加群验证（join_requests 有 approved 记录）。
 * 绑定加群验证机器人后，壳 bot 以此判定免重复验证直接放行。
 */
export async function hasApprovedVerification(userId: number): Promise<boolean> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT id FROM join_requests WHERE user_id = ? AND status = 'approved' LIMIT 1`,
    [userId],
  );
  return row !== null;
}

// ============ mirror_callbacks ============

export interface MirrorCallbackRow {
  proxyKey: string;
  targetMsgId: number;
  buttonText: string | null;
  buttonData: Uint8Array | null;
  proxyChatId: number | null;
  userId: number | null;
  createdAt: number;
  staleAt: number | null;
}

function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  return null;
}

export async function putMirrorCallback(input: {
  proxyKey: string;
  targetMsgId: number;
  buttonText?: string | null;
  buttonData?: Uint8Array | null;
  proxyChatId?: number | null;
  userId?: number | null;
  staleAfterSeconds?: number | null;
}): Promise<void> {
  const now = Date.now();
  const staleAt =
    input.staleAfterSeconds && input.staleAfterSeconds > 0 ? now + input.staleAfterSeconds * 1000 : null;
  await executeRun(
    `INSERT INTO mirror_callbacks
       (proxy_key, target_msg_id, button_text, button_data, proxy_chat_id, user_id, created_at, stale_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(proxy_key) DO UPDATE SET
       target_msg_id = excluded.target_msg_id,
       button_text = excluded.button_text,
       button_data = excluded.button_data,
       proxy_chat_id = excluded.proxy_chat_id,
       user_id = excluded.user_id,
       created_at = excluded.created_at,
       stale_at = excluded.stale_at`,
    [
      input.proxyKey,
      input.targetMsgId,
      input.buttonText ?? null,
      input.buttonData ?? null,
      input.proxyChatId ?? null,
      input.userId ?? null,
      now,
      staleAt,
    ],
  );
}

export async function getMirrorCallback(proxyKey: string): Promise<MirrorCallbackRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM mirror_callbacks WHERE proxy_key = ?`,
    [proxyKey],
  );
  if (!row) return null;
  return {
    proxyKey: String(row.proxy_key),
    targetMsgId: Number(row.target_msg_id),
    buttonText: row.button_text === null ? null : String(row.button_text),
    buttonData: toBytes(row.button_data),
    proxyChatId: row.proxy_chat_id === null ? null : Number(row.proxy_chat_id),
    userId: row.user_id === null ? null : Number(row.user_id),
    createdAt: Number(row.created_at),
    staleAt: row.stale_at === null ? null : Number(row.stale_at),
  };
}

export async function deleteMirrorCallback(proxyKey: string): Promise<void> {
  await executeRun(`DELETE FROM mirror_callbacks WHERE proxy_key = ?`, [proxyKey]);
}

export async function purgeStaleMirrorCallbacks(): Promise<number> {
  const result = await executeRun(
    `DELETE FROM mirror_callbacks WHERE stale_at IS NOT NULL AND stale_at < ?`,
    [Date.now()],
  );
  return result.changes;
}

// ============ mirror_targets ============

export interface MirrorTargetRow {
  username: string;
  title: string | null;
  description: string | null;
  commandsCache: { command: string; description: string }[] | null;
  lastProbedAt: number | null;
}

export async function upsertMirrorTarget(input: {
  username: string;
  title?: string | null;
  description?: string | null;
  commands?: { command: string; description: string }[] | null;
}): Promise<void> {
  const commandsJson = input.commands ? JSON.stringify(input.commands) : null;
  await executeRun(
    `INSERT INTO mirror_targets (username, title, description, commands_cache, last_probed_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET
       title = COALESCE(excluded.title, mirror_targets.title),
       description = COALESCE(excluded.description, mirror_targets.description),
       commands_cache = COALESCE(excluded.commands_cache, mirror_targets.commands_cache),
       last_probed_at = excluded.last_probed_at`,
    [input.username, input.title ?? null, input.description ?? null, commandsJson, Date.now()],
  );
}

export async function getMirrorTarget(username: string): Promise<MirrorTargetRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM mirror_targets WHERE username = ?`,
    [username.replace(/^@/, "").toLowerCase()],
  );
  if (!row) return null;
  let commands: { command: string; description: string }[] | null = null;
  if (typeof row.commands_cache === "string" && row.commands_cache) {
    try {
      const parsed = JSON.parse(row.commands_cache) as unknown;
      commands = Array.isArray(parsed) ? (parsed as { command: string; description: string }[]) : null;
    } catch (error) {
      console.error(`[mirror] mirror_targets.commands_cache 解析失败（username=${String(row.username)}）:`, error);
    }
  }
  return {
    username: String(row.username),
    title: row.title === null ? null : String(row.title),
    description: row.description === null ? null : String(row.description),
    commandsCache: commands,
    lastProbedAt: row.last_probed_at === null ? null : Number(row.last_probed_at),
  };
}

// ============ mirror_jobs（L2 大媒体作业） ============

export interface MirrorJobRow {
  id: number;
  userId: number | null;
  proxyChatId: number | null;
  targetMsgId: number;
  mediaKind: string | null;
  status: string;
  error: string | null;
  claimedAt: number | null;
  createdAt: number;
}

export async function createMirrorJob(input: {
  userId?: number | null;
  proxyChatId?: number | null;
  targetMsgId: number;
  mediaKind?: string | null;
}): Promise<number> {
  const result = await executeRun(
    `INSERT INTO mirror_jobs (user_id, proxy_chat_id, target_msg_id, media_kind, status, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
    [
      input.userId ?? null,
      input.proxyChatId ?? null,
      input.targetMsgId,
      input.mediaKind ?? null,
      Date.now(),
    ],
  );
  return result.lastInsertRowid;
}

export async function finishMirrorJob(id: number, status: string, error?: string | null): Promise<void> {
  await executeRun(`UPDATE mirror_jobs SET status = ?, error = ? WHERE id = ?`, [
    status,
    error ?? null,
    id,
  ]);
}

export async function listMirrorJobs(status?: string, limit = 50): Promise<MirrorJobRow[]> {
  const params: SqlParam[] = [];
  let sql = `SELECT * FROM mirror_jobs`;
  if (status) {
    sql += ` WHERE status = ?`;
    params.push(status);
  }
  sql += ` ORDER BY id DESC LIMIT ?`;
  params.push(limit);
  const rows = await queryAll<Record<string, unknown>>(sql, params);
  return rows.map(mapJob);
}

function mapJob(row: Record<string, unknown>): MirrorJobRow {
  return {
    id: Number(row.id),
    userId: row.user_id === null ? null : Number(row.user_id),
    proxyChatId: row.proxy_chat_id === null ? null : Number(row.proxy_chat_id),
    targetMsgId: Number(row.target_msg_id),
    mediaKind: row.media_kind === null ? null : String(row.media_kind),
    status: String(row.status),
    error: row.error === null ? null : String(row.error),
    claimedAt: row.claimed_at === null ? null : Number(row.claimed_at),
    createdAt: Number(row.created_at),
  };
}

export async function purgeFinishedMirrorJobs(olderThanMs: number): Promise<number> {
  const result = await executeRun(
    `DELETE FROM mirror_jobs WHERE status IN ('done', 'failed') AND created_at < ?`,
    [Date.now() - olderThanMs],
  );
  return result.changes;
}

// ============ mirror_logs（双向留痕审计） ============

export type MirrorLogDirection = "inbound" | "outbound" | "click" | "failover" | "error";

export async function logMirrorEvent(input: {
  userId?: number | null;
  direction: MirrorLogDirection;
  event: string;
  payload?: unknown;
}): Promise<void> {
  try {
    await executeRun(
      `INSERT INTO mirror_logs (user_id, direction, event, payload, created_at) VALUES (?, ?, ?, ?, ?)`,
      [
        input.userId ?? null,
        input.direction,
        input.event,
        input.payload === undefined ? null : JSON.stringify(input.payload),
        Date.now(),
      ],
    );
  } catch (error) {
    console.error(`[mirror] 写审计日志失败（direction=${input.direction} event=${input.event}）:`, error);
  }
}

export async function listMirrorLogs(limit = 100): Promise<
  { id: number; userId: number | null; direction: string; event: string; payload: string | null; createdAt: number }[]
> {
  const rows = await queryAll<Record<string, unknown>>(
    `SELECT * FROM mirror_logs ORDER BY id DESC LIMIT ?`,
    [limit],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    userId: row.user_id === null ? null : Number(row.user_id),
    direction: String(row.direction ?? ""),
    event: String(row.event ?? ""),
    payload: row.payload === null ? null : String(row.payload),
    createdAt: Number(row.created_at),
  }));
}

export async function purgeMirrorLogs(olderThanMs: number): Promise<number> {
  const result = await executeRun(`DELETE FROM mirror_logs WHERE created_at < ?`, [
    Date.now() - olderThanMs,
  ]);
  return result.changes;
}
