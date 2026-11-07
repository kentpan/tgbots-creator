import { NextResponse } from "next/server";
import { verifyRelaySignature } from "@/bot/mirror/relay";
import { createMirrorJob } from "@/bot/mirror/store";

export const runtime = "nodejs";

/** 中继面创建 L2 媒体作业（remote 模式 HMAC 鉴权） */
export async function POST(request: Request): Promise<NextResponse> {
  const timestamp = request.headers.get("x-mirror-timestamp") ?? "";
  const signature = request.headers.get("x-mirror-signature") ?? "";
  const body = await request.text();
  if (!verifyRelaySignature(timestamp, body, signature)) {
    console.error("[mirror-api] jobs 创建验签失败");
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const payload = JSON.parse(body) as {
      targetMsgId?: number;
      mediaKind?: string;
      userId?: number | null;
    };
    if (!Number.isFinite(Number(payload.targetMsgId))) {
      return NextResponse.json({ ok: false, error: "targetMsgId required" }, { status: 400 });
    }
    const id = await createMirrorJob({
      targetMsgId: Number(payload.targetMsgId),
      mediaKind: payload.mediaKind ?? null,
      userId: payload.userId ?? null,
    });
    return NextResponse.json({ ok: true, id });
  } catch (error) {
    console.error("[mirror-api] jobs 创建失败:", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
