import { NextResponse } from "next/server";
import { executeRun, queryAll } from "@/database/client";
import { verifyRelaySignature } from "@/bot/mirror/relay";

export const runtime = "nodejs";

/**
 * 中继面认领 L2 作业（remote 模式 HMAC 鉴权）：
 * 返回 pending 作业并标记 claimed_at（幂等：重复认领返回空集）。
 */
export async function POST(request: Request): Promise<NextResponse> {
  const timestamp = request.headers.get("x-mirror-timestamp") ?? "";
  const signature = request.headers.get("x-mirror-signature") ?? "";
  const body = await request.text();
  if (!(await verifyRelaySignature(timestamp, body, signature))) {
    console.error("[mirror-api] jobs claim 验签失败");
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const rows = await queryAll<Record<string, unknown>>(
      `SELECT id, user_id, proxy_chat_id, target_msg_id, media_kind FROM mirror_jobs
       WHERE status = 'pending' ORDER BY id ASC LIMIT 10`,
    );
    for (const row of rows) {
      await executeRun(`UPDATE mirror_jobs SET status = 'claimed', claimed_at = ? WHERE id = ? AND status = 'pending'`, [
        Date.now(),
        Number(row.id),
      ]);
    }
    return NextResponse.json({
      ok: true,
      jobs: rows.map((row) => ({
        id: Number(row.id),
        userId: row.user_id === null ? null : Number(row.user_id),
        proxyChatId: row.proxy_chat_id === null ? null : Number(row.proxy_chat_id),
        targetMsgId: Number(row.target_msg_id),
        mediaKind: row.media_kind === null ? null : String(row.media_kind),
      })),
    });
  } catch (error) {
    console.error("[mirror-api] jobs claim 失败:", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
