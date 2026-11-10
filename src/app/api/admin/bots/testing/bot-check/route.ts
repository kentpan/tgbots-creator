import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission } from "@/lib/auth";
import { getBot } from "@/database/operations";
import { planBotCheckNodes, runBotCheckNode } from "@/services/bot-check";

/**
 * 机器人关键节点真实检测 API（v2.2.7，仿真页「机器人检测」数据源）。
 *
 * POST { bot_id }               → 返回该机器人的关键节点检测计划（不发任何网络请求）
 * POST { bot_id, index }        → 真实执行第 index 个节点：真实 Telegram API 调用 /
 *                                 真实数据库读取 / 真实运行实例状态，返回 ✅/❌ + 耗时 +
 *                                 真实数据摘要（❌ 附详细错误与修复建议）。
 * 客户端按顺序逐节点调用，收到 ❌ 即停止 —— 与真实检测语义一致。
 */
export async function POST(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "bots:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }

  let payload: { bot_id?: string | number; index?: number };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  let botId: bigint;
  try {
    botId = BigInt(payload.bot_id ?? "");
  } catch {
    return NextResponse.json({ ok: false, error: "机器人 ID 不合法" }, { status: 400 });
  }
  const bot = await getBot(botId);
  if (!bot) {
    return NextResponse.json({ ok: false, error: "机器人不存在" }, { status: 404 });
  }

  if (payload.index === undefined || payload.index === null) {
    const nodes = await planBotCheckNodes(bot);
    return NextResponse.json({ ok: true, plan: nodes });
  }
  const index = Number(payload.index);
  if (!Number.isInteger(index) || index < 0) {
    return NextResponse.json({ ok: false, error: "节点下标不合法" }, { status: 400 });
  }
  try {
    const result = await runBotCheckNode(bot, index);
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    // 检测器自身异常（如下标越界）如实返回，绝不静默吞掉
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
