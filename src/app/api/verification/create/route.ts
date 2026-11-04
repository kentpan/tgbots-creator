import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { config } from "@/config/settings";
import { createJoinRequest, createVerificationSession } from "@/database/operations";
import { generateVerificationToken } from "@/utils/crypto";
import { utcnow } from "@/utils/time";

function verifyApiKey(request: Request): NextResponse | null {
  if (!config.api.enable) {
    console.warn("API access attempted but API is disabled");
    return NextResponse.json({ detail: "API访问已禁用" }, { status: 403 });
  }

  if (!config.api.apiKey) {
    console.error("API is enabled but API key is not configured");
    return NextResponse.json({ detail: "API配置错误" }, { status: 500 });
  }

  const provided = request.headers.get("x-api-key");
  if (!provided) {
    return NextResponse.json(
      { detail: "无效的API密钥" },
      {
        status: 401,
        headers: { "WWW-Authenticate": "X-API-Key" },
      },
    );
  }

  const a = Buffer.from(provided);
  const b = Buffer.from(config.api.apiKey);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    console.warn("Invalid API key attempted");
    return NextResponse.json(
      { detail: "无效的API密钥" },
      {
        status: 401,
        headers: { "WWW-Authenticate": "X-API-Key" },
      },
    );
  }

  return null;
}

export async function POST(request: Request) {
  const authError = verifyApiKey(request);
  if (authError) {
    return authError;
  }

  try {
    let body: { user_id?: unknown };
    try {
      body = (await request.json()) as { user_id?: unknown };
    } catch {
      return NextResponse.json({ detail: "请求格式错误" }, { status: 422 });
    }

    const userIdRaw = body.user_id;
    if (typeof userIdRaw !== "number" || !Number.isInteger(userIdRaw)) {
      return NextResponse.json({ detail: "请求格式错误" }, { status: 422 });
    }
    const userId = BigInt(userIdRaw);

    console.log(`Creating verification request via API for user ${userId}`);

    const verificationToken = generateVerificationToken();

    const expiresAt = new Date(utcnow().getTime() + config.captcha.expireMinutes * 60 * 1000);

    const chatId = 0n;

    const dbJoinRequest = await createJoinRequest({
      userId,
      chatId,
      username: null,
      firstName: "",
      lastName: null,
      verificationToken,
      requestType: "api",
    });

    if (!dbJoinRequest) {
      console.error(`Failed to create join request for user ${userId}`);
      return NextResponse.json({ detail: "创建验证请求失败" }, { status: 500 });
    }

    const verificationSession = await createVerificationSession({
      token: verificationToken,
      userId,
      chatId,
      expiresAt,
    });

    if (!verificationSession) {
      console.error(`Failed to create verification session for user ${userId}`);
      return NextResponse.json({ detail: "创建验证会话失败" }, { status: 500 });
    }

    const verificationUrl = `${config.api.baseUrl}/verify?token=${verificationToken}`;

    console.log(
      `Verification request created successfully for user ${userId}, token: ${verificationToken.slice(0, 8)}...`,
    );

    return NextResponse.json({
      token: verificationToken,
      verification_url: verificationUrl,
      expires_at: expiresAt.toISOString(),
    });
  } catch (error) {
    console.error("Unexpected error creating verification request:", error);
    return NextResponse.json({ detail: "服务器内部错误" }, { status: 500 });
  }
}
