import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { getCurrentAdmin, hasPermission, logOperation } from "@/lib/auth";
import {
  getPublicSessionStorageConfig,
  normalizeSessionBackend,
  testSessionStorage,
  buildStoragePublicUrl,
  SESSION_STORAGE_SETTING_KEY,
  SESSION_STORAGE_D1_KEYS,
  SESSION_STORAGE_R2_KEYS,
  SESSION_STORAGE_S3_KEYS,
} from "@/bot/session-storage";
import { setAppSetting } from "@/database/operations";

/** 当前会话存储配置（敏感字段打码；数据构造与设置页 RSC 直传共用 getPublicSessionStorageConfig） */
export async function GET(): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  if (!hasPermission(admin, "settings:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }
  return NextResponse.json({ ok: true, data: await getPublicSessionStorageConfig() });
}

interface TestPayload {
  action?: "test";
  backend?: string;
  d1?: { account_id?: string; database_id?: string; api_token?: string };
  r2?: { account_id?: string; access_key_id?: string; secret_access_key?: string; bucket?: string; cdn_url?: string };
  s3?: {
    endpoint?: string;
    region?: string;
    bucket?: string;
    access_key_id?: string;
    secret_access_key?: string;
    path_style?: string;
    cdn_url?: string;
  };
}

/** 保存会话存储配置（action=test 时用表单当前值做连通性测试） */
export async function POST(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  if (!hasPermission(admin, "settings:manage")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const d1 = (payload.d1 ?? {}) as TestPayload["d1"];
  const r2 = (payload.r2 ?? {}) as TestPayload["r2"];
  const s3 = (payload.s3 ?? {}) as TestPayload["s3"];

  if (payload.action === "test") {
    const backend = normalizeSessionBackend(payload.backend);
    const result = await testSessionStorage(backend);
    // CDN 公开访问 URL 预览（R2/S3 后端）：配置了自定义 CDN 域名时公开读取走该域名
    let publicUrl: { url: string; via_cdn: boolean } | null = null;
    if (backend === "r2" || backend === "s3") {
      const preview = await buildStoragePublicUrl(backend, "sessions/__probe__.json");
      publicUrl = { url: preview.url, via_cdn: preview.viaCdn };
    }
    return NextResponse.json({
      ok: result.ok,
      data: { detail: result.detail, latency_ms: result.latencyMs, public_url: publicUrl },
    });
  }

  // 保存配置
  const updates: [string, string][] = [
    [SESSION_STORAGE_SETTING_KEY, normalizeSessionBackend(payload.backend)],
    ...(d1?.account_id !== undefined ? ([[SESSION_STORAGE_D1_KEYS.accountId, String(d1.account_id).trim()]] as [string, string][]) : []),
    ...(d1?.database_id !== undefined ? ([[SESSION_STORAGE_D1_KEYS.databaseId, String(d1.database_id).trim()]] as [string, string][]) : []),
    ...(d1?.api_token && !String(d1.api_token).includes("****") ? ([[SESSION_STORAGE_D1_KEYS.apiToken, String(d1.api_token).trim()]] as [string, string][]) : []),
    ...(r2?.account_id !== undefined ? ([[SESSION_STORAGE_R2_KEYS.accountId, String(r2.account_id).trim()]] as [string, string][]) : []),
    ...(r2?.access_key_id !== undefined ? ([[SESSION_STORAGE_R2_KEYS.accessKeyId, String(r2.access_key_id).trim()]] as [string, string][]) : []),
    ...(r2?.secret_access_key && !String(r2.secret_access_key).includes("****") ? ([[SESSION_STORAGE_R2_KEYS.secretAccessKey, String(r2.secret_access_key).trim()]] as [string, string][]) : []),
    ...(r2?.bucket !== undefined ? ([[SESSION_STORAGE_R2_KEYS.bucket, String(r2.bucket).trim()]] as [string, string][]) : []),
    ...(r2?.cdn_url !== undefined ? ([[SESSION_STORAGE_R2_KEYS.cdnUrl, String(r2.cdn_url).trim()]] as [string, string][]) : []),
    ...(s3?.endpoint !== undefined ? ([[SESSION_STORAGE_S3_KEYS.endpoint, String(s3.endpoint).trim()]] as [string, string][]) : []),
    ...(s3?.region !== undefined ? ([[SESSION_STORAGE_S3_KEYS.region, String(s3.region).trim()]] as [string, string][]) : []),
    ...(s3?.bucket !== undefined ? ([[SESSION_STORAGE_S3_KEYS.bucket, String(s3.bucket).trim()]] as [string, string][]) : []),
    ...(s3?.access_key_id !== undefined ? ([[SESSION_STORAGE_S3_KEYS.accessKeyId, String(s3.access_key_id).trim()]] as [string, string][]) : []),
    ...(s3?.secret_access_key && !String(s3.secret_access_key).includes("****") ? ([[SESSION_STORAGE_S3_KEYS.secretAccessKey, String(s3.secret_access_key).trim()]] as [string, string][]) : []),
    ...(s3?.path_style !== undefined ? ([[SESSION_STORAGE_S3_KEYS.pathStyle, String(s3.path_style).trim() === "virtual_hosted" ? "virtual_hosted" : "path"]] as [string, string][]) : []),
    ...(s3?.cdn_url !== undefined ? ([[SESSION_STORAGE_S3_KEYS.cdnUrl, String(s3.cdn_url).trim()]] as [string, string][]) : []),
  ];
  for (const [key, value] of updates) {
    await setAppSetting(key, value);
  }

  const requestHeaders = await headers();
  await logOperation(admin, {
    action: "保存 BOT 会话存储配置",
    target: "bot.session_storage",
    detail: `后端: ${normalizeSessionBackend(payload.backend)}`,
    headers: requestHeaders,
  });
  return NextResponse.json({ ok: true });
}
