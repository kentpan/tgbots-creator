import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission } from "@/lib/auth";
import { getD1EnvDefaults, getR2EnvDefaults } from "@/bot/session-storage";
import { listCloudflareD1Databases, listCloudflareR2Buckets, probeCloudflareAccountId } from "@/lib/cloudflare-api";

/**
 * 部署默认值查询（v2.0.9，v2.2.6 增强）—— 设置页「BOT 数据存储」卡片右上角「默认配置」按钮的数据源。
 *
 * 取值优先级：
 * 1. pages-deploy.yml 部署时注入的环境变量：
 *    - D1:  TG_D1_ACCOUNT_ID / TG_D1_DATABASE_ID / TG_D1_API_TOKEN（部署账号 + 本次 D1 库 + 部署 token）
 *    - R2:  TG_R2_ACCOUNT_ID / TG_R2_BUCKET（部署账号 + 工作流 R2_NAME）
 * 2. v2.2.6：环境变量缺失的字段通过 CLOUDFLARE_API_TOKEN（回退 TG_D1_API_TOKEN）按
 *    pages-deploy.yml「Resolve Cloudflare account ID」同源方式自动探测补齐：
 *    - account_id ← GET /client/v4/accounts 第一个账号
 *    - d1.database_id ← GET /accounts/{id}/storage/d1/database 第一个库
 *    - r2.bucket ← GET /accounts/{id}/r2/buckets 第一个桶
 *    探测失败该字段留空且错误原因写入 note（不静默、接口不 500）。
 *
 * ⚠ TG_D1_API_TOKEN 返回真实值（填入表单后由管理员显式保存）：
 *   端点仅限已登录管理员（settings:view 权限），读取的是部署方自己的 token。
 * ⚠ R2 的 Access Key ID / Secret Access Key 属 R2 控制台创建的 S3 兼容凭证，
 *   部署工作流不含，无默认值 —— 由 note 字段说明，前端提示用户手动填写。
 */
export async function GET(): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  if (!hasPermission(admin, "settings:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }

  const d1 = getD1EnvDefaults();
  const r2 = getR2EnvDefaults();

  const notes: string[] = [];
  // Token 优先级与运行时注入语义一致：CLOUDFLARE_API_TOKEN > TG_D1_API_TOKEN
  const token = (process.env.CLOUDFLARE_API_TOKEN ?? "").trim() || d1.apiToken;

  let d1AccountId = d1.accountId;
  let d1DatabaseId = d1.databaseId;
  let r2AccountId = r2.accountId;
  let r2Bucket = r2.bucket;

  if (token) {
    // 账号 ID：env 缺失时自动探测（D1/R2 共用同一探测结果）
    if (!d1AccountId || !r2AccountId) {
      try {
        const probed = await probeCloudflareAccountId(token);
        if (!d1AccountId) d1AccountId = probed;
        if (!r2AccountId) r2AccountId = probed;
      } catch (error) {
        notes.push(`账号 ID 自动探测失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // D1 库 ID：env 缺失时列库取第一个（workflow「D1 数据库已存在」同源查询）
    if (d1AccountId && !d1DatabaseId) {
      try {
        const databases = await listCloudflareD1Databases(token, d1AccountId);
        d1DatabaseId = databases[0]?.uuid ?? "";
        if (!d1DatabaseId) notes.push("该账号下未找到任何 D1 数据库");
      } catch (error) {
        notes.push(`D1 库列表获取失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // R2 桶：env 缺失时列桶取第一个（workflow「Create R2 bucket」同源查询）
    if (r2AccountId && !r2Bucket) {
      try {
        const buckets = await listCloudflareR2Buckets(token, r2AccountId);
        r2Bucket = buckets[0]?.name ?? "";
        if (!r2Bucket) notes.push("该账号下未找到任何 R2 存储桶（未开通 R2 或尚未创建桶）");
      } catch (error) {
        notes.push(`R2 桶列表获取失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } else {
    notes.push("未配置 CLOUDFLARE_API_TOKEN / TG_D1_API_TOKEN，无法自动探测 D1/R2 默认值");
  }

  return NextResponse.json({
    ok: true,
    data: {
      d1: {
        account_id: d1AccountId,
        database_id: d1DatabaseId,
        api_token: d1.apiToken,
      },
      r2: {
        account_id: r2AccountId,
        bucket: r2Bucket,
      },
      note: [
        "R2 Access Key ID / Secret Access Key 属 Cloudflare 控制台（R2 → 管理 API 令牌）创建的 S3 兼容凭证，部署工作流不含，无默认值",
        ...notes,
      ].join("；"),
    },
  });
}
