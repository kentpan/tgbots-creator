import { NextResponse } from "next/server";
import { verifyRelaySignature } from "@/bot/mirror/relay";
import { queryAll } from "@/database/client";

export const runtime = "nodejs";

/**
 * 加群申请增量同步 API（供本地/自托管环境拉取线上数据，双向库保持一致视图）：
 * GET /api/v1/sync/join-requests?since=<ISO 时间>，HMAC(MIRROR_RELAY_SECRET) 鉴权，
 * GET 以空 body 参与签名。按 request_time 升序分页（每页 ≤500 条）。
 */
export async function GET(request: Request): Promise<NextResponse> {
  const timestamp = request.headers.get("x-mirror-timestamp") ?? "";
  const signature = request.headers.get("x-mirror-signature") ?? "";
  if (!verifyRelaySignature(timestamp, "", signature)) {
    console.error("[sync-api] join-requests 拉取验签失败");
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const sinceRaw = new URL(request.url).searchParams.get("since") ?? "";
    const sinceDate = new Date(sinceRaw);
    const since = Number.isNaN(sinceDate.getTime()) ? "1970-01-01T00:00:00.000Z" : sinceDate.toISOString();
    const rows = await queryAll<Record<string, unknown>>(
      `SELECT user_id, chat_id, username, first_name, verification_token, status,
              request_time, verification_completed, admin_id, processed_time, request_type
       FROM join_requests
       WHERE request_time > ?
       ORDER BY request_time ASC
       LIMIT 500`,
      [since],
    );
    const last = rows.length > 0 ? String(rows[rows.length - 1].request_time) : since;
    return NextResponse.json({
      ok: true,
      requests: rows,
      next_since: last,
      has_more: rows.length === 500,
    });
  } catch (error) {
    console.error("[sync-api] join-requests 拉取失败:", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
