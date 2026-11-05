import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission } from "@/lib/auth";
import { getBot } from "@/database/operations";
import { botByToken, getMeCached, withTelegramTimeout } from "@/services/telegram-sync";

interface MeInfo {
  id: number;
  username: string;
  first_name: string;
  /** Inline Mode（BotFather 专属，API 只读） */
  supports_inline_queries: boolean;
  /** Allow Groups?（BotFather 专属，API 只读） */
  can_join_groups: boolean;
  /** Group Privacy：true = 已关闭隐私模式（可读取全部群消息） */
  can_read_all_group_messages: boolean;
  /** Secretary Mode / 商务模式（BotFather 专属，API 只读） */
  can_connect_to_business: boolean;
  /** 是否配置了主 Web App */
  has_main_web_app: boolean;
}

/**
 * 用 BotFather Token 真实调用 Bot API getMe，自动获取机器人身份与能力开关。
 * 传入 botId 时复用该机器人已保存的 Token（编辑弹窗自动获取）；否则使用表单中输入的 Token。
 */
export async function POST(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  if (!hasPermission(admin, "bots:manage")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }

  let payload: { token?: string; botId?: string };
  try {
    payload = (await request.json()) as { token?: string; botId?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  let token = (payload.token ?? "").trim();
  if (!token && payload.botId && /^\d+$/.test(payload.botId)) {
    const record = await getBot(BigInt(payload.botId));
    token = record?.token ?? "";
  }
  if (!token || !/^\d{6,}:[\w-]{30,}$/.test(token)) {
    return NextResponse.json({ ok: false, error: "请先填写有效的 BotFather Token（格式：123456789:AA…）" }, { status: 400 });
  }

  try {
    // v2.0.3：复用 telegram-sync 的 getMe 缓存（10 分钟）—— 编辑弹窗重复打开同一机器人、
    // 新建后连续操作同一 Token 时零网络调用；失败不缓存，Token 失效每次真实暴露
    const bot = botByToken(token);
    const me = await withTelegramTimeout(getMeCached(bot.api, token)).then((cached) => cached.user!);
    const info: MeInfo = {
      id: me.id,
      username: me.username ?? "",
      first_name: me.first_name ?? "",
      supports_inline_queries: me.supports_inline_queries === true,
      can_join_groups: me.can_join_groups === true,
      can_read_all_group_messages: me.can_read_all_group_messages === true,
      can_connect_to_business: me.can_connect_to_business === true,
      has_main_web_app: me.has_main_web_app === true,
    };
    return NextResponse.json({ ok: true, data: info });
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    // Telegram 明确返回 401：Token 无效/被撤销（真实 API 结果，直接给出可操作指引）
    if (/401|unauthorized/i.test(raw)) {
      return NextResponse.json({
        ok: false,
        error:
          "Token 无效或已被撤销（Telegram 401 Unauthorized）：请到 @BotFather → /mybots → API Token 查看当前 Token，若已撤销请重新生成，并更新此处的 Token 后重试。",
      });
    }
    return NextResponse.json({ ok: false, error: `getMe 失败：${raw.slice(0, 200)}` });
  }
}
