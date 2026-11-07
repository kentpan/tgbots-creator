import { NextResponse } from "next/server";
import { verifyRelaySignature } from "@/bot/mirror/relay";
import { listDeveloperAccounts } from "@/database/operations";

export const runtime = "nodejs";

/**
 * 开发者账号列表（供外部中继网关拉取，如 aliyun-hk proxy-gateway 的「中继模式」）：
 * HMAC(MIRROR_RELAY_SECRET) 鉴权，GET 请求 body 记为空串参与签名。
 * 返回 api_hash 明文 —— 持有共享密钥的网关本就拥有中继面凭据信任级别；
 * 面板侧只做掩码展示，不落日志。
 */
export async function GET(request: Request): Promise<NextResponse> {
  const timestamp = request.headers.get("x-mirror-timestamp") ?? "";
  const signature = request.headers.get("x-mirror-signature") ?? "";
  if (!verifyRelaySignature(timestamp, "", signature)) {
    console.error("[mirror-api] developer-accounts 拉取验签失败");
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const accounts = await listDeveloperAccounts();
    return NextResponse.json({
      ok: true,
      accounts: accounts.map((account) => ({
        id: String(account.id),
        apiId: String(account.apiId),
        apiHash: String(account.apiHash),
        phone: account.phone ?? "",
        remark: account.remark ?? "",
      })),
    });
  } catch (error) {
    console.error("[mirror-api] developer-accounts 拉取失败:", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
