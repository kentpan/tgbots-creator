import { NextResponse } from "next/server";
import { verifyRelaySignature } from "@/bot/mirror/relay";
import { listBots } from "@/database/operations";
import { parseMirrorConfig, resolveMirrorConfig } from "@/bot/mirror/types";

export const runtime = "nodejs";

/**
 * 镜像机器人配置拉取（供外部中继网关一键接入）：
 * GET /api/v1/mirror/bots，HMAC(MIRROR_RELAY_SECRET) 鉴权（GET 以空 body 签名）。
 * 返回全部已配置 mirror 段的机器人及其完整中继配置（含壳 bot Token 明文——
 * 持有共享密钥的一方即拥有中继面凭据信任级别，与开发者账号 api_hash 同策略），
 * 网关侧选择后自动回填，无需手工重复配置。
 */
export async function GET(request: Request): Promise<NextResponse> {
  const timestamp = request.headers.get("x-mirror-timestamp") ?? "";
  const signature = request.headers.get("x-mirror-signature") ?? "";
  if (!(await verifyRelaySignature(timestamp, "", signature))) {
    console.error("[mirror-api] bots 拉取验签失败");
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const rows = await listBots();
    const bots = rows
      .map((row) => {
        const cfg = parseMirrorConfig(row.config);
        if (!cfg) return null;
        const resolved = resolveMirrorConfig(cfg);
        return {
          id: String(row.id),
          name: row.name,
          username: row.username ?? null,
          targetBot: resolved.targetBot,
          proxyBotToken: row.token,
          serializeMode: resolved.serializeMode,
          actionTimeoutSeconds: resolved.actionTimeoutSeconds,
          mediaInlineMaxMb: resolved.mediaInlineMaxMb,
          rewriteRules: Object.entries(resolved.rewriteRules)
            .map(([from, to]) => `${from}=${to}`)
            .join("\n"),
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
    return NextResponse.json({ ok: true, bots });
  } catch (error) {
    console.error("[mirror-api] bots 拉取失败:", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
