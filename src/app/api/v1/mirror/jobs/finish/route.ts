import { NextResponse } from "next/server";
import { verifyRelaySignature } from "@/bot/mirror/relay";
import { finishMirrorJob } from "@/bot/mirror/store";

export const runtime = "nodejs";

/** 中继面回写作业终态（remote 模式 HMAC 鉴权） */
export async function POST(request: Request): Promise<NextResponse> {
  const timestamp = request.headers.get("x-mirror-timestamp") ?? "";
  const signature = request.headers.get("x-mirror-signature") ?? "";
  const body = await request.text();
  if (!(await verifyRelaySignature(timestamp, body, signature))) {
    console.error("[mirror-api] jobs finish 验签失败");
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const payload = JSON.parse(body) as { id?: number; status?: string; error?: string | null };
    if (!Number.isFinite(Number(payload.id)) || !payload.status) {
      return NextResponse.json({ ok: false, error: "id/status required" }, { status: 400 });
    }
    await finishMirrorJob(Number(payload.id), payload.status, payload.error ?? null);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[mirror-api] jobs finish 失败:", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
