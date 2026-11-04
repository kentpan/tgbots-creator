import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission } from "@/lib/auth";
import { listXianyuProducts } from "@/database/xianyu-operations";

/** 已导入的闲鱼商品列表（机器人测试页左侧面板，含详情所需全部字段） */
export async function GET(): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "bots:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }
  const products = await listXianyuProducts(100);
  return NextResponse.json({
    ok: true,
    products: products.map((row) => ({
      id: String(row.id),
      externalId: row.externalId,
      title: row.title,
      price: row.price,
      description: row.description,
      imageUrl: row.imageUrl,
      detailJson: row.detailJson,
      sourceUrl: row.sourceUrl,
      rawJson: row.rawJson,
      createdTime: row.createdTime.toISOString(),
    })),
  });
}
