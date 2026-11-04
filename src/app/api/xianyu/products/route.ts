import { NextResponse } from "next/server";
import { checkVerifyApiKey, generateOrderNo } from "@/services/verify-codes";

/**
 * 内置演示版「闲鱼商品」接口（Bearer apikey 鉴权）。
 *
 * 用于在没有真实闲鱼/发货业务系统时联调「机器人测试」页面的导入流程：
 *   GET/POST /api/xianyu/products?count=5
 *   Authorization: Bearer <apikey>
 *
 * 响应契约：{ "success": boolean, "msg": string, "data": { "list": [...] } }
 * 真实业务系统返回 data.list / data.items / 根数组均可被导入器自动识别。
 */
const SAMPLE_PRODUCTS = [
  {
    id: "xy_1001",
    title: "Telegram 高级会员群 · 入群资格（月卡）",
    price: "19.90",
    description: "付款后自动发货入群验证码，凭验证码完成加群验证即可入群。",
    pic: "https://img.alicdn.com/xianyu/telegram-vip-group.jpg",
    stock: 998,
    shop: "数字权益小铺",
  },
  {
    id: "xy_1002",
    title: "AI 绘画交流群 · 入群码（季卡）",
    price: "49.00",
    description: "Midjourney/SD 交流群季卡，发码后 72 小时内有效。",
    pic: "https://img.alicdn.com/xianyu/ai-art-group.jpg",
    stock: 456,
    shop: "创意工坊",
  },
  {
    id: "xy_1003",
    title: "美股研报精华群 · 入群资格",
    price: "99.00",
    description: "每日盘前研报推送，验证码即买即用。",
    pic: "https://img.alicdn.com/xianyu/stock-research.jpg",
    stock: 230,
    shop: "价值投资社",
  },
  {
    id: "xy_1004",
    title: "独立开发者出海群 · 终身会员",
    price: "199.00",
    description: "一次购买终身有效，含历史 300+ 篇出海复盘。",
    pic: "https://img.alicdn.com/xianyu/indie-dev.jpg",
    stock: 88,
    shop: "出海百晓生",
  },
  {
    id: "xy_1005",
    title: "考研资料共享群 · 入群码",
    price: "9.90",
    description: "全网真题 + 笔记汇总，付款秒发验证码。",
    pic: "https://img.alicdn.com/xianyu/kaoyan-notes.jpg",
    stock: 1200,
    shop: "上岸资料库",
  },
  {
    id: "xy_1006",
    title: "健身打卡监督群 · 月度入群码",
    price: "29.90",
    description: "教练在线监督 + 每周训练计划，验证码 48 小时有效。",
    pic: "https://img.alicdn.com/xianyu/fitness-camp.jpg",
    stock: 150,
    shop: "铁馆合伙人",
  },
];

async function resolveCount(request: Request): Promise<number> {
  let count = 5;
  const url = new URL(request.url);
  // 兼容自定义条数参数名：优先常见命名，其次取任意数值型查询参数
  const preferred = ["count", "limit", "num", "page_size", "pageSize", "size"];
  for (const name of preferred) {
    const value = Number(url.searchParams.get(name) ?? "");
    if (Number.isFinite(value) && value > 0) {
      count = Math.floor(value);
      break;
    }
  }
  if (count === 5) {
    const numericParam = url.searchParams
      .entries()
      .filter(([, value]) => /^\d+$/.test(value.trim()) && Number(value) > 0)
      .map(([, value]) => Number(value))
      .next().value;
    if (numericParam !== undefined) count = Math.floor(numericParam);
  }
  if (request.method === "POST") {
    try {
      const body = (await request.json()) as Record<string, unknown>;
      const entries = Object.entries(body);
      const fromPreferred = entries.find(
        ([key, value]) =>
          preferred.includes(key) &&
          (typeof value === "number" || typeof value === "string") &&
          Number.isFinite(Number(value)) &&
          Number(value) > 0,
      );
      const numericEntry =
        fromPreferred ??
        entries.find(
          ([, value]) =>
            (typeof value === "number" || typeof value === "string") &&
            /^\d+$/.test(String(value).trim()) &&
            Number(value) > 0,
        );
      if (numericEntry !== undefined) count = Math.floor(Number(numericEntry[1]));
    } catch {
      /* ignore empty body */
    }
  }
  return Math.min(Math.max(count, 1), 50);
}

async function handle(request: Request): Promise<NextResponse> {
  const auth = await checkVerifyApiKey(request);
  if (!auth.ok) {
    return NextResponse.json({ success: false, msg: auth.error, data: {} });
  }
  const count = await resolveCount(request);
  const list = Array.from({ length: count }, (_, index) => {
    const sample = SAMPLE_PRODUCTS[index % SAMPLE_PRODUCTS.length];
    const batch = Math.floor(index / SAMPLE_PRODUCTS.length) + 1;
    return {
      ...sample,
      id: batch > 1 ? `${sample.id}_b${batch}` : sample.id,
      order_no: generateOrderNo(),
      listed_at: new Date().toISOString(),
    };
  });
  return NextResponse.json({
    success: true,
    msg: `返回 ${list.length} 件闲鱼商品（内置演示数据）`,
    data: { list, total: list.length },
  });
}

export async function GET(request: Request): Promise<NextResponse> {
  return handle(request);
}

export async function POST(request: Request): Promise<NextResponse> {
  return handle(request);
}
