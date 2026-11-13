import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission } from "@/lib/auth";
import { getBot, listGroupBotAdmins } from "@/database/operations";
import { parseGroupDeployState } from "@/services/group-deploy";

/**
 * 群组的机器人管理员列表（v2.3 仿真屏分体部署按钮数据源）：
 * GET ?chat_id= → 该群全部机器人管理员 + 真实部署状态
 * （group_bot_admins.rights 的部署状态 = parseGroupDeployState，与列表徽章同一判定）。
 */
export async function GET(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "bots:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }

  const chatIdRaw = new URL(request.url).searchParams.get("chat_id") ?? "";
  let chatId: bigint;
  try {
    chatId = BigInt(chatIdRaw);
  } catch {
    return NextResponse.json({ ok: false, error: "群组 Chat ID 不合法" }, { status: 400 });
  }

  const admins = await listGroupBotAdmins(chatId);
  const items: { id: string; name: string; username: string | null; deployed: boolean }[] = [];
  for (const entry of admins) {
    if (entry.status !== "active") continue;
    const bot = await getBot(entry.botId);
    if (!bot) continue;
    const deployState = parseGroupDeployState(entry.rights);
    items.push({
      id: String(bot.id),
      name: bot.name,
      username: bot.username,
      deployed: deployState !== null && deployState.deploy_mode === "join_request",
    });
  }

  return NextResponse.json({ ok: true, data: { items } });
}
