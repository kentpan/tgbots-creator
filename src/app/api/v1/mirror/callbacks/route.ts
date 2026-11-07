import { NextResponse } from "next/server";
import { verifyRelaySignature } from "@/bot/mirror/relay";
import { putMirrorCallback } from "@/bot/mirror/store";

export const runtime = "nodejs";

/**
 * 中继面回调 key 回写（remote 模式）：HMAC(MIRROR_RELAY_SECRET) 鉴权。
 * inprocess 模式中继面直调 store，不经过本路由。
 */
export async function POST(request: Request): Promise<NextResponse> {
  const timestamp = request.headers.get("x-mirror-timestamp") ?? "";
  const signature = request.headers.get("x-mirror-signature") ?? "";
  const body = await request.text();
  if (!verifyRelaySignature(timestamp, body, signature)) {
    console.error("[mirror-api] callbacks 回写验签失败");
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const payload = JSON.parse(body) as {
      proxyKey?: string;
      targetMsgId?: number;
      buttonText?: string | null;
      buttonData?: string | null;
      staleAfterSeconds?: number;
    };
    if (!payload.proxyKey || !Number.isFinite(Number(payload.targetMsgId))) {
      return NextResponse.json({ ok: false, error: "proxyKey/targetMsgId required" }, { status: 400 });
    }
    await putMirrorCallback({
      proxyKey: payload.proxyKey,
      targetMsgId: Number(payload.targetMsgId),
      buttonText: payload.buttonText ?? null,
      buttonData: payload.buttonData ? new Uint8Array(Buffer.from(payload.buttonData, "base64")) : null,
      staleAfterSeconds: payload.staleAfterSeconds ?? null,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[mirror-api] callbacks 回写失败:", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
