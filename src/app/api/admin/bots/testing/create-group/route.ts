import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission, logOperation } from "@/lib/auth";
import { headers } from "next/headers";
import { getBot, getAppSetting, setAppSetting } from "@/database/operations";
import { tgRawCall } from "@/lib/telegram/transport";

/**
 * v2.0.15 新建群组（仿真屏「新建会话」按钮 → APP 风格建群流程）：
 *
 * UI 流程复刻 Telegram 新建群组：选机器人（替代原「选择用户」）→ 下一步 →
 * 输入群组名称 → 确定。
 *
 * ⚠️ 真实边界（诚实实现）：Telegram Bot API 没有任何「创建群组」方法（bot 无法凭空
 * 建群，群组只能由用户客户端创建 —— Bot API 仅有 createChatInviteLink 等群内操作）。
 * 因此本接口做的是「真实可用的最接近实现」：
 * 1. getMe 实时校验所选机器人 Token（经全局代理链路，真实 Telegram 请求）；
 * 2. 把 { 机器人, 群名 } 登记为本系统的「待绑定群组」（app_settings
 *    telegram.pending_groups），语义 = 已登记、等待真实群组落地；
 * 3. 返回喂饭级指引：在 Telegram App 中新建同名群组并把机器人拉进去，
 *    之后点「同步真实群组」—— 同步管道发现同名真实群组即自动绑定
 *    （chat_registry + group_bot_admins 正常登记，待绑定条目自动消除）。
 *
 * GET ?bot_id= → 返回该机器人的待绑定群组列表（面板展示「等待创建」条目）。
 */

const PENDING_KEY = "telegram.pending_groups";
const MAX_PENDING = 30;

interface PendingGroup {
  id: string;
  bot_id: string;
  bot_username: string | null;
  title: string;
  created_at: string;
}

async function loadPending(): Promise<PendingGroup[]> {
  const raw = await getAppSetting(PENDING_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is PendingGroup =>
        !!item &&
        typeof item === "object" &&
        typeof (item as PendingGroup).id === "string" &&
        typeof (item as PendingGroup).bot_id === "string" &&
        typeof (item as PendingGroup).title === "string",
    );
  } catch {
    return [];
  }
}

async function savePending(list: PendingGroup[]): Promise<void> {
  await setAppSetting(PENDING_KEY, JSON.stringify(list.slice(-MAX_PENDING)));
}

/** GET：该机器人的待绑定群组列表 */
export async function GET(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "bots:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }
  const botId = new URL(request.url).searchParams.get("bot_id") ?? "";
  const pending = (await loadPending()).filter((item) => !botId || item.bot_id === botId);
  return NextResponse.json({ ok: true, data: { pending } });
}

/** POST：登记新建群组（机器人 + 群名 → 待绑定条目 + 建群指引） */
export async function POST(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "bots:manage")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }

  let payload: { bot_id?: string; title?: string };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const botId = (payload.bot_id ?? "").trim();
  const title = (payload.title ?? "").trim().slice(0, 128);
  if (!botId) {
    return NextResponse.json({ ok: false, error: "请选择机器人" }, { status: 400 });
  }
  if (!title) {
    return NextResponse.json({ ok: false, error: "请输入群组名称" }, { status: 400 });
  }

  let botIdBigInt: bigint;
  try {
    botIdBigInt = BigInt(botId);
  } catch {
    return NextResponse.json({ ok: false, error: "机器人 ID 不合法" }, { status: 400 });
  }
  const bot = await getBot(botIdBigInt);
  if (!bot) {
    return NextResponse.json({ ok: false, error: "机器人不存在" }, { status: 404 });
  }

  // ① 真实校验机器人身份（经全局代理链路调用 Telegram getMe）
  let botUsername: string | null = bot.username ?? null;
  try {
    const me = await tgRawCall<{ ok: boolean; result?: { username?: string }; description?: string }>(
      bot.token,
      "getMe",
    );
    if (me?.ok && me.result?.username) {
      botUsername = me.result.username;
    } else {
      return NextResponse.json(
        {
          ok: false,
          error: `机器人 Token 校验失败：${me?.description ?? "Telegram 无响应（请检查代理偏好设置）"}`,
        },
        { status: 200 },
      );
    }
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: `机器人 Token 校验失败：${error instanceof Error ? error.message : String(error)}（请检查「代理偏好设置」中的代理连通性）`,
      },
      { status: 200 },
    );
  }

  // ② 登记待绑定群组（同机器人同名去重，保留最早登记时间）
  const pending = await loadPending();
  const existing = pending.find((item) => item.bot_id === botId && item.title === title);
  const entry: PendingGroup = existing ?? {
    id: `g${Date.now()}${Math.floor(Math.random() * 1000)}`,
    bot_id: botId,
    bot_username: botUsername,
    title,
    created_at: new Date().toISOString(),
  };
  if (!existing) pending.push(entry);
  await savePending(pending);

  const requestHeaders = await headers();
  await logOperation(admin, {
    action: "新建群组（登记待绑定）",
    target: bot.name,
    detail: `群名「${title}」· @${botUsername ?? "bot"}`,
    headers: requestHeaders,
  });

  return NextResponse.json({
    ok: true,
    data: {
      pending: true,
      id: entry.id,
      title,
      bot_username: botUsername,
      guide: [
        `在 Telegram App 中新建群组，群组名称填写「${title}」`,
        "把该机器人拉进群组（建群时直接添加，或建好后邀请进群）",
        "回到本页点击「同步真实群组」—— 系统发现同名真实群组后自动完成绑定",
        "绑定后即可对该群组执行一键部署 / 模拟加群申请 / 验证配置",
      ],
      note:
        "Telegram 官方限制：Bot API 不允许机器人凭空创建群组（群组只能由用户客户端创建），" +
        "系统已按所选机器人与群名登记待绑定条目，真实群组落地后自动绑定。",
    },
  });
}

/** DELETE ?id=：删除待绑定条目（真实群组已手动绑定/放弃建群时清理） */
export async function DELETE(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "bots:manage")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }
  const id = new URL(request.url).searchParams.get("id") ?? "";
  const pending = await loadPending();
  const next = pending.filter((item) => item.id !== id);
  if (next.length !== pending.length) {
    await savePending(next);
  }
  return NextResponse.json({ ok: true });
}
