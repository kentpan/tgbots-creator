import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission } from "@/lib/auth";
import { getD1EnvDefaults, getR2EnvDefaults } from "@/bot/session-storage";

/**
 * 部署默认值查询（v2.0.9）—— 设置页「BOT 数据存储」卡片右上角「默认配置」按钮的数据源。
 *
 * 值来自 pages-deploy.yml 部署时注入的环境变量：
 * - D1:  TG_D1_ACCOUNT_ID / TG_D1_DATABASE_ID / TG_D1_API_TOKEN（部署账号 + 本次 D1 库 + 部署 token）
 * - R2:  TG_R2_ACCOUNT_ID / TG_R2_BUCKET（部署账号 + 工作流 R2_NAME）
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
  return NextResponse.json({
    ok: true,
    data: {
      d1: {
        account_id: d1.accountId,
        database_id: d1.databaseId,
        api_token: d1.apiToken,
      },
      r2: {
        account_id: r2.accountId,
        bucket: r2.bucket,
      },
      note: "R2 Access Key ID / Secret Access Key 属 Cloudflare 控制台（R2 → 管理 API 令牌）创建的 S3 兼容凭证，部署工作流不含，无默认值",
    },
  });
}
