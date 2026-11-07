import { NextResponse } from "next/server";
import { getCurrentAdmin, hasPermission } from "@/lib/auth";
import {
  getBot,
  getGroupBotAdminByBotAndChat,
  getGroupSettings,
  getVerificationMethod,
  listGroupBotAdmins,
} from "@/database/operations";
import { parseGroupDeployState } from "@/services/group-deploy";
import { botByToken, describeSyncError, withTelegramTimeout } from "@/services/telegram-sync";
import { assertRemoteExecution } from "@/services/remote-ops-guard";

/** 尝试获取真实群成员数（机器人需在群内；失败返回 null，面板降级显示群 ID） */
async function fetchMemberCount(botToken: string | null, chatId: bigint): Promise<number | null> {
  if (!botToken) return null;
  try {
    const api = botByToken(botToken).api;
    return await withTelegramTimeout(api.getChatMemberCount(Number(chatId)));
  } catch (error) {
    console.error(`resolve-invite: getChatMemberCount failed (chat=${chatId}):`, describeSyncError(error));
    return null;
  }
}

/**
 * 解析加群链接（机器人测试页仿真屏「搜索框输入加群链接」）。
 *
 * 只依据系统真实落库的数据做匹配，绝不臆造群组：
 * ① 深链 t.me/<bot_username>?start=join_<chat_id>（deploy 指引推荐的买家入口）
 *    → 直接得到 chat_id，读 group_settings 验证配置；
 * ② 邀请链接 t.me/+<hash> / t.me/joinchat/<hash>
 *    → 与 group_bot_admins.rights JSON 中一键部署保存的 invite_link 匹配
 *      （deploy API createChatInviteLink(creates_join_request) 的产物）。
 *
 * join_request_enabled = 该群组当前部署模式为 creates_join_request（新成员审核开启），
 * 此时仿真屏展示「申请加入」按钮，申请由加群验证机器人接管（与真实 chat_join_request 一致）。
 */
export async function GET(request: Request): Promise<NextResponse> {

  // v2.0.12 node 环境兜底：已配置线上站点时禁止本地直连执行（前端 opsFetch 已自动转发线上）
  const blocked = await assertRemoteExecution(request);
  if (blocked) return blocked;
  const admin = await getCurrentAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  if (!hasPermission(admin, "bots:view")) {
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  }

  const url = new URL(request.url);
  const link = (url.searchParams.get("link") ?? "").trim();
  const botIdRaw = (url.searchParams.get("bot_id") ?? "").trim();
  if (!link) {
    return NextResponse.json({ ok: false, error: "请输入加群链接" }, { status: 400 });
  }

  // —— 第一步：识别链接形态 ——
  // 深链形态：t.me/<bot>?start=join_<chat_id>
  let deepChatId: string | null = null;
  const deepMatch = link.match(/start=join_(-?\d+)/i);
  if (deepMatch) deepChatId = deepMatch[1];

  // 邀请链接 hash：t.me/+<hash> 或 t.me/joinchat/<hash>
  let inviteHash: string | null = null;
  const plusMatch = link.match(/t\.me\/\+([A-Za-z0-9_-]+)/i);
  const joinchatMatch = link.match(/t\.me\/joinchat\/([A-Za-z0-9_-]+)/i);
  if (plusMatch) inviteHash = plusMatch[1];
  else if (joinchatMatch) inviteHash = joinchatMatch[1];

  if (!deepChatId && !inviteHash) {
    return NextResponse.json({
      ok: false,
      error:
        "无法识别的加群链接：支持 t.me/+xxxx、t.me/joinchat/xxxx 或 t.me/<机器人>?start=join_<群组ID>",
    });
  }

  // —— 第二步 A：深链 → chat_id 直查 ——
  if (deepChatId) {
    let chatId: bigint;
    try {
      chatId = BigInt(deepChatId);
    } catch {
      return NextResponse.json({ ok: false, error: "深链中的群组 ID 不合法" }, { status: 400 });
    }
    const settings = await getGroupSettings(chatId);
    if (!settings) {
      return NextResponse.json({
        ok: false,
        error: `链接指向的群组（${deepChatId}）尚未在本系统登记，请先在群组管理中配置或一键部署`,
      });
    }
    let botUsername: string | null = null;
    let botToken: string | null = null;
    if (/^\d+$/.test(botIdRaw)) {
      const bot = await getBot(BigInt(botIdRaw));
      botUsername = bot?.username ?? null;
      botToken = bot?.token ?? null;
    } else {
      // 未指定 bot：取该群第一个活跃绑定机器人的 Token（与机器人测试页同 Token 关联逻辑一致）
      const binding = (await listGroupBotAdmins(chatId))[0];
      if (binding) {
        const bot = await getBot(binding.botId);
        botUsername = bot?.username ?? null;
        botToken = bot?.token ?? null;
      }
    }
    const memberCount = await fetchMemberCount(botToken, chatId);
    const method =
      settings.methodId !== null && settings.methodId !== undefined
        ? await getVerificationMethod(settings.methodId)
        : null;
    return NextResponse.json({
      ok: true,
      data: {
        resolve_type: "deep_link",
        chat_id: String(chatId),
        chat_title: settings.chatTitle ?? `群组 ${deepChatId}`,
        join_request_enabled: true,
        method: settings.method,
        method_name:
          settings.method === "code_self"
            ? "自动验证码（输入验证码加群）"
            : settings.method === "code_api"
              ? method?.name ?? "自定义验证码（外部 API）"
              : "人机验证码（WebApp）",
        enabled: settings.enabled,
        bot_username: botUsername,
        member_count: memberCount,
      },
    });
  }

  // —— 第二步 B：邀请链接 hash → 与部署保存的 invite_link 匹配 ——
  const hashLower = (inviteHash ?? "").toLowerCase();
  const admins = await listGroupBotAdmins();
  // 优先匹配当前选中机器人（bot_id 合法时），找不到再全局匹配（同 Token 多条目场景）
  let matchedBotId: bigint | null = null;
  let matchedChatId: bigint | null = null;
  let matchedLink: string | null = null;

  const botIdPref = /^\d+$/.test(botIdRaw) ? BigInt(botIdRaw) : null;
  const candidates = botIdPref
    ? [...admins].sort((a, b) => {
        const aPref = a.botId === botIdPref ? 0 : 1;
        const bPref = b.botId === botIdPref ? 0 : 1;
        return aPref - bPref;
      })
    : admins;

  for (const botAdmin of candidates) {
    const deploy = parseGroupDeployState(botAdmin.rights);
    const inviteLink = deploy?.invite_link ?? null;
    if (!inviteLink) continue;
    const linkTail = inviteLink.split("/").pop() ?? "";
    if (!linkTail) continue;
    // Telegram 邀请链接 hash 大小写敏感，但宽松匹配可避免用户复制时改动大小写导致失败
    if (linkTail.toLowerCase() === hashLower || inviteLink.toLowerCase().endsWith(hashLower)) {
      matchedBotId = botAdmin.botId;
      matchedChatId = botAdmin.chatId;
      matchedLink = inviteLink;
      break;
    }
  }

  if (matchedChatId === null || matchedBotId === null) {
    return NextResponse.json({
      ok: false,
      error:
        "邀请链接未被识别：请确认该链接是本系统「一键部署」生成的入群申请链接（普通邀请链接无法被加群验证机器人接管）",
    });
  }

  const settings = await getGroupSettings(matchedChatId);
  const deploy = await getGroupBotAdminByBotAndChat(matchedBotId, matchedChatId);
  const deployState = deploy ? parseGroupDeployState(deploy.rights) : null;
  const bot = await getBot(matchedBotId);

  const method =
    settings && settings.methodId !== null && settings.methodId !== undefined
      ? await getVerificationMethod(settings.methodId)
      : null;

  return NextResponse.json({
    ok: true,
    data: {
      resolve_type: "invite_link",
      chat_id: String(matchedChatId),
      chat_title: settings?.chatTitle ?? deployState?.chat_title ?? `群组 ${String(matchedChatId)}`,
      join_request_enabled: deployState?.deploy_mode === "join_request",
      invite_link: matchedLink,
      method: settings?.method ?? null,
      method_name:
        settings?.method === "code_self"
          ? "自动验证码（输入验证码加群）"
          : settings?.method === "code_api"
            ? method?.name ?? "自定义验证码（外部 API）"
            : settings?.method === "captcha"
              ? "人机验证码（WebApp）"
              : null,
      enabled: settings?.enabled ?? false,
      bot_id: String(matchedBotId),
      bot_username: deployState?.bot_username ?? bot?.username ?? null,
      member_count: await fetchMemberCount(bot?.token ?? null, matchedChatId),
    },
  });
}
