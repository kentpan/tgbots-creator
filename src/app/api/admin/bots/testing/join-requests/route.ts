import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission, logOperation } from "@/lib/auth";
import { headers } from "next/headers";
import {
  approveJoinRequest,
  getBot,
  getJoinRequestByToken,
  listJoinRequests,
  rejectJoinRequest,
} from "@/database/operations";
import { approveJoinRequestRemote, declineJoinRequestRemote } from "@/services/telegram-sync";

/**
 * v2.0.16 仿真屏「加群申请」列表与审批（与真实 Telegram APP 一致）：
 *
 * - GET ?chat_id=X → 该群组全部待处理（pending）加群申请，供聊天区顶部
 *   「N 条加群请求」横幅点击后的上滑申请列表展示；
 * - POST { chat_id, token, action: "approve"|"deny", bot_id } → 审批一条申请：
 *   · 真实 Telegram 申请（request_type=telegram 且非仿真用户）：必须先经
 *     approveChatJoinRequest / declineChatJoinRequest 真实同步成功才落库 ——
 *     Telegram 侧失败（申请已失效/机器人权限不足等）返回明确错误且不落库，
 *     保证数据库状态与 Telegram 群组真实成员一致；
 *   · 仿真申请（模拟加群申请产生）：Telegram 侧无此申请，仅落库并附说明。
 *
 * 源头复用：与「加群申请」管理页（/admin/join-requests）同一落库管道
 * （approveJoinRequest / rejectJoinRequest），审批结果两处同步可见。
 */

/** 仿真屏固定模拟用户（与 join-request 路由的 SIMULATED_USER_ID 一致） */
const SIMULATED_USER_ID = 777000n;

interface JoinRequestItem {
  id: string;
  token: string;
  user_id: string;
  username: string | null;
  first_name: string;
  last_name: string | null;
  /** ISO 时间（北京时间展示由前端处理） */
  request_time: string;
  request_type: string;
}

export async function GET(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "requests:view")) {
    return NextResponse.json({ ok: false, error: "无权限（需要加群申请查看权限）" }, { status: 403 });
  }

  const chatIdRaw = new URL(request.url).searchParams.get("chat_id") ?? "";
  let chatId: bigint;
  try {
    chatId = BigInt(chatIdRaw);
  } catch {
    return NextResponse.json({ ok: false, error: "群组 Chat ID 不合法" }, { status: 400 });
  }

  const { rows, total } = await listJoinRequests({
    chatId,
    status: "pending",
    page: 1,
    pageSize: 100,
  });

  const items: JoinRequestItem[] = rows.map((row) => ({
    id: String(row.id),
    token: row.verificationToken,
    user_id: String(row.userId),
    username: row.username,
    first_name: row.firstName,
    last_name: row.lastName,
    request_time: row.requestTime instanceof Date ? row.requestTime.toISOString() : String(row.requestTime),
    request_type: row.requestType,
  }));

  return NextResponse.json({ ok: true, data: { total, items } });
}

export async function POST(request: Request): Promise<NextResponse> {
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "requests:manage")) {
    return NextResponse.json({ ok: false, error: "无权限（需要加群申请管理权限）" }, { status: 403 });
  }

  let payload: { chat_id?: string; token?: string; action?: string; bot_id?: string };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const chatIdRaw = String(payload.chat_id ?? "").trim();
  const token = String(payload.token ?? "").trim();
  const action = String(payload.action ?? "").trim();
  const botIdRaw = String(payload.bot_id ?? "").trim();
  if (!chatIdRaw || !/^-?\d+$/.test(chatIdRaw) || !token || !["approve", "deny"].includes(action)) {
    return NextResponse.json(
      { ok: false, error: "参数不完整（chat_id / token / action=approve|deny）" },
      { status: 400 },
    );
  }
  const chatId = BigInt(chatIdRaw);

  const joinRequest = await getJoinRequestByToken(token);
  if (!joinRequest) {
    return NextResponse.json({ ok: false, error: "加群申请不存在或已被清理" }, { status: 404 });
  }
  if (String(joinRequest.chatId) !== chatIdRaw) {
    return NextResponse.json({ ok: false, error: "申请与群组不匹配" }, { status: 400 });
  }
  if (joinRequest.status !== "pending") {
    return NextResponse.json({ ok: false, error: "该申请已处理过（仅待处理申请可审批）" }, { status: 400 });
  }

  // 审批执行身份：测试页当前选中的机器人（其 Token 收到的申请由它审批）
  const bot = botIdRaw ? await getBot(BigInt(botIdRaw)) : null;
  if (!bot && action === "approve" && joinRequest.userId !== SIMULATED_USER_ID && joinRequest.requestType === "telegram") {
    return NextResponse.json({ ok: false, error: "未指定审批机器人（bot_id）" }, { status: 400 });
  }

  let notice = "";
  if (joinRequest.userId === SIMULATED_USER_ID || joinRequest.requestType !== "telegram") {
    // 仿真申请 / 外部 API 申请：Telegram 侧无真实 join request，仅落库
    notice = "仿真申请：已更新本地申请状态（Telegram 群组中无此真实申请）";
  }

  if (bot) {
    const remote = action === "approve"
      ? await approveJoinRequestRemote(bot.token, chatId, joinRequest.userId)
      : await declineJoinRequestRemote(bot.token, chatId, joinRequest.userId);
    if (!remote.ok) {
      if (!notice) {
        // 真实 Telegram 申请：Telegram 同步失败绝不落库（保持待处理，用户可重试）
        return NextResponse.json(
          { ok: false, error: `Telegram 同步失败：${remote.error ?? "未知错误"}` },
          { status: 200 },
        );
      }
      notice += `（Telegram 同步：${remote.error ?? "失败"}，仿真申请可忽略）`;
    } else if (!notice) {
      // v2.1.1：幂等容错说明（用户已在群组/申请已不存在）优先展示，替代笼统的成功文案
      notice = remote.note
        ? `${action === "approve" ? "已通过" : "已拒绝"}：${remote.note}`
        : action === "approve"
          ? "已通过 Telegram API 真实批准该申请（用户已进群）"
          : "已通过 Telegram API 真实拒绝该申请";
    }
  }

  const dbOk = action === "approve"
    ? await approveJoinRequest(token, admin.user.id)
    : await rejectJoinRequest(token, admin.user.id);
  if (!dbOk) {
    return NextResponse.json({ ok: false, error: "落库失败，请查看服务端日志后重试" }, { status: 500 });
  }

  const requestHeaders = await headers();
  await logOperation(admin, {
    action: action === "approve" ? "仿真屏批准加群申请" : "仿真屏拒绝加群申请",
    target: `${chatIdRaw} · 用户 ${joinRequest.userId}`,
    detail: notice,
    headers: requestHeaders,
  });

  return NextResponse.json({ ok: true, data: { notice } });
}
