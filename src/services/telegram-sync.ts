import { Bot, GrammyError } from "grammy";
import { describeTelegramError, isTelegramRequestAlreadyHandled } from "./approval";
import {
  tgRawCall,
  telegramBotClientOptions,
  type TgOutboundDiagnostics,
} from "@/lib/telegram/transport";
import { registerInviteLinkTracking } from "@/bot/invite-link-tracking";
import {
  deleteGroupBotAdminsByChatAndBots,
  listBots,
  listGroupBotAdmins,
} from "@/database/operations";

/**
 * 机器人测试页与 Telegram 的真实同步通道：
 * - getMe 拉取机器人身份；群组发现靠数据库已关联群组 + getChat/getChatMember 实时验证
 *   （v2.2.6 起不再调用 getUpdates —— 与 Webhook 严格互斥，会破坏线上事件推送）
 * - sendMessage 将仿真动作（验证提示 / 成功文案）真实发送到群组（「同步到群组」开关开启时）
 * - approveChatJoinRequest 真实批准加群申请
 *
 * 所有调用均为一次性管理操作，不启动轮询；Bot 实例按 Token 缓存复用。
 */

// v1.2.0：25s —— 代理网关单次尝试上限已放宽到 20s（实测延迟 5~13.5s 波动），
// 原 15s 总超时会误杀「慢但成功」的网关调用，导致管理端保存报「Telegram API 请求超时」
const REQUEST_TIMEOUT_MS = 25000;

const botCache = new Map<string, Bot>();

/** getMe 结果缓存（v1.2.0）：机器人 id/username 极少变化，10 分钟内复用。
 *  管理端保存动作从「getMe+getChatMember 两次串行调用」降到「单次 getChatMember」，
 *  代理网关单次 5~13s 时收益显著。仅缓存成功结果（401 等失败每次重试，可及时发现 Token 失效） */
interface BotMeInfo {
  id: number;
  username: string | null;
  /** 完整 getMe User（v2.0.3：供 fetch-info 需要能力字段时复用，同 Token 10 分钟内零网络调用） */
  user: MeUser | null;
  cachedAt: number;
}
/** grammY getMe 返回的 User 形态（只取用到的字段，避免引入类型依赖） */
type MeUser = {
  id: number;
  username?: string;
  first_name?: string;
  supports_inline_queries?: boolean;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
  can_connect_to_business?: boolean;
  has_main_web_app?: boolean;
};
const meCache = new Map<string, BotMeInfo>();
const ME_CACHE_TTL_MS = 10 * 60 * 1000;

export async function getMeCached(
  api: Bot["api"],
  token: string,
): Promise<{ id: number; username: string | null; user: MeUser | null }> {
  const cached = meCache.get(token);
  if (cached && Date.now() - cached.cachedAt < ME_CACHE_TTL_MS) return cached;
  const me = (await api.getMe()) as MeUser;
  const info: BotMeInfo = {
    id: Number(me.id),
    username: me.username ?? null,
    user: me,
    cachedAt: Date.now(),
  };
  meCache.set(token, info);
  return info;
}

export function botByToken(token: string): Bot {
  const cached = botCache.get(token);
  if (cached) return cached;
  const bot = new Bot(token, telegramBotClientOptions());
  // v2.1.2 邀请链接台账：管理动作（审批补发链接等 resolveBotForChat 路径）创建的链接同样落库
  registerInviteLinkTracking(bot, token);
  botCache.set(token, bot);
  return bot;
}

export interface SyncActionResult {
  ok: boolean;
  error: string | null;
  /** v2.1.1：幂等容错说明（如「用户已在群组中」），供调用方拼进结果提示 */
  note?: string | null;
}

/** 将 Telegram API 错误翻译为可读中文（网络不可达 / 超时 / Bot API 业务错误） */
export function describeSyncError(error: unknown): string {
  if (error instanceof GrammyError) {
    return describeTelegramError(error) ?? `Telegram API 错误：${error.description}`;
  }
  const raw = error instanceof Error ? error.message : String(error);
  const lowered = raw.toLowerCase();
  let message: string;
  if (lowered.includes("timeout") || lowered.includes("abort")) {
    message = "Telegram API 请求超时";
  } else if (
    lowered.includes("fetch failed") ||
    lowered.includes("network") ||
    lowered.includes("econnrefused") ||
    lowered.includes("enotfound") ||
    lowered.includes("eai_again") ||
    lowered.includes("unreachable")
  ) {
    message = "无法连接 Telegram API（网络不可达）";
  } else {
    message = raw || "Telegram API 调用失败";
  }
  // v2.0.4：运输层出站诊断（每次尝试的路径/耗时/错误）附在错误上，
  // 线上不再只剩一句「网络不可达」，运维可以直接看到失败在哪一跳
  const diagnostics = extractOutboundDiagnostics(error);
  if (diagnostics) message = `${message}${formatOutboundDiagnostics(diagnostics)}`;
  return message;
}

/** 从错误对象（含 grammY HttpError.error / Error.cause 包装）中提取出站诊断 */
function extractOutboundDiagnostics(error: unknown): TgOutboundDiagnostics | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { tgOutbound?: TgOutboundDiagnostics; error?: unknown; cause?: unknown };
    if (candidate.tgOutbound) return candidate.tgOutbound;
    current = candidate.error ?? candidate.cause;
  }
  return null;
}

/** 出站诊断 → 紧凑可读文本（例：【出站诊断 runtime=edge/workerk target=https://api.telegram.org 直连(0.2s): Network connection lost. → 代理(8.1s): ...】） */
function formatOutboundDiagnostics(diagnostics: TgOutboundDiagnostics): string {
  const attempts = diagnostics.attempts
    .map(
      (attempt) =>
        `${attempt.path}(${(attempt.ms / 1000).toFixed(1)}s${attempt.error ? `: ${attempt.error}` : ""})`,
    )
    .join(" → ");
  const parts = [
    `runtime=${diagnostics.runtime}`,
    diagnostics.userAgent ? `ua=${diagnostics.userAgent}` : null,
    `target=${diagnostics.targetOrigin}`,
    `总耗时${(diagnostics.elapsedMs / 1000).toFixed(1)}s`,
    attempts ? `尝试: ${attempts}` : null,
  ].filter(Boolean);
  return `【出站诊断 ${parts.join(" | ")}】`;
}

/** 向真实聊天发送一条消息（仿真动作同步到群组时使用） */
export async function sendChatMessage(
  token: string,
  chatId: bigint,
  text: string,
): Promise<SyncActionResult> {
  try {
    await withTelegramTimeout(botByToken(token).api.sendMessage(Number(chatId), text));
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: describeSyncError(error) };
  }
}

/** 真实批准加群申请（仿真用户在 Telegram 中无待审申请时由 Telegram 拒绝并透传原因）
 *
 * v2.1.1 幂等容错（修「通过申请报错 USER_ALREADY_PARTICIPANT」）：
 * - 用户已是群成员（群内验证 bootstrap 此前已批准过 / 在 TG 客户端已被其它管理员批准）
 *   → 按成功处理并附说明 —— 用户确实已在群里，审批目的已达成，绝不让记录永远卡在待处理；
 * - 申请已在 Telegram 侧不存在（REQUEST_NOT_FOUND，已被客户端处理/用户撤回）
 *   → 同样按成功处理并附说明，让管理端能正常落库清理。
 */
export async function approveJoinRequestRemote(
  token: string,
  chatId: bigint,
  userId: bigint,
): Promise<SyncActionResult> {
  try {
    await withTelegramTimeout(
      botByToken(token).api.approveChatJoinRequest(Number(chatId), Number(userId)),
    );
    return { ok: true, error: null };
  } catch (error) {
    const handled = isTelegramRequestAlreadyHandled(error);
    if (handled === "already_participant") {
      return {
        ok: true,
        error: null,
        note: "用户已在群组中（Telegram 侧申请此前已被批准或用户已直接入群），本次按已通过处理",
      };
    }
    if (handled === "request_gone") {
      return {
        ok: true,
        error: null,
        note: "Telegram 侧已无此加群申请（可能已在 TG 客户端处理或被用户撤回），本次按当前动作落库",
      };
    }
    return { ok: false, error: describeSyncError(error) };
  }
}

/** 真实拒绝加群申请（v2.0.16 仿真屏加群申请列表「拒绝申请」按钮：declineChatJoinRequest）
 * v2.1.1：申请已不存在/用户已是成员时按成功落库（附说明），不再报错卡死记录 */
export async function declineJoinRequestRemote(
  token: string,
  chatId: bigint,
  userId: bigint,
): Promise<SyncActionResult> {
  try {
    await withTelegramTimeout(
      botByToken(token).api.declineChatJoinRequest(Number(chatId), Number(userId)),
    );
    return { ok: true, error: null };
  } catch (error) {
    const handled = isTelegramRequestAlreadyHandled(error);
    if (handled === "request_gone") {
      return {
        ok: true,
        error: null,
        note: "Telegram 侧已无此加群申请（可能已在 TG 客户端处理或被用户撤回），本次按当前动作落库",
      };
    }
    if (handled === "already_participant") {
      return {
        ok: true,
        error: null,
        note: "用户已在群组中，Telegram 侧无待审申请可拒绝；本次仅更新本地状态（如需移出该成员请在 TG 客户端操作或由验证超时清理处理）",
      };
    }
    return { ok: false, error: describeSyncError(error) };
  }
}

/** 为 grammy API 调用附加超时限制（grammy 默认无超时，沙箱/断网时会永久挂起） */
export async function withTelegramTimeout<T>(promise: Promise<T>): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Telegram API 请求超时")),
        REQUEST_TIMEOUT_MS,
      );
      if (typeof timer === "object" && timer && "unref" in timer) {
        (timer as { unref: () => void }).unref();
      }
    }),
  ]);
}

export interface RealChatInfo {
  chatId: string;
  chatTitle: string;
  /** v2.3 聊天类型（group/supergroup/channel，getChat 实时返回；群组/频道统一展示） */
  chatType: string | null;
  /** 发现来源：getchat=已关联群组经 getChat+getChatMember 验证机器人仍在群内 */
  source: "getchat";
}

export interface RealGroupsResult {
  ok: boolean;
  error?: string;
  botUsername: string | null;
  chats: RealChatInfo[];
  /** 经 getChat/getChatMember 确认失效的群组（群不存在或机器人已 left/kicked）；
   *  确认失效时已同步移除 group_bot_admins 关联行（网络错误/超时一律不删防误删） */
  staleChatIds: string[];
  /** v2.0.4：因网络错误/超时未能完成校验的候选群组数（未删除关联，也不计入 chats）。
   *  防止「校验全失败 → 返回空列表」被误读为「机器人不在任何群组」 */
  unverifiedCount: number;
  /** 未能校验的群组与原因（最多 3 条，供管理端提示） */
  unverifiedReasons: string[];
}

/**
 * 拉取 bot token 真实所在的群组（v2.2.6 起两源合并）。
 *
 * v2.2.6 移除 getUpdates 源（2026-11-11「部署成功后机器人全场景静默」事故根因）：
 * getUpdates 与 Webhook 在 Telegram 侧严格互斥 —— webhook 活跃时同步必先 409，
 * 自愈需 deleteWebhook → getUpdates → setWebhook 恢复，而恢复调用只知道 Token、
 * 不知道机器人行 id，无法重算 per-bot 回调密钥（botWebhookSecret(botId, token)），
 * 注册上去的 Webhook 密钥被清空 → Telegram 推送全被 401 拒收；且该链路与部署动作
 * 并发时存在删除/注册竞态。群组发现改由两源：
 *
 * 1. 数据库已关联群组：group_bot_admins（仅限当前 Token 对应的机器人条目；
 *    运行实例收到群事件时由 chat-tracking → chat-registry 自动登记）
 * 2. getChat + getChatMember 逐一验证：确认机器人仍在群内并取回最新群名；
 *    确认失效（Telegram 400 群不存在，或机器人成员身份 left/kicked）的群组仅移除
 *    当前 Token 机器人的 group_bot_admins 关联行并归入 stale 提示；
 *    网络错误/超时/429 等不确定结果一律不删（防误删）
 *
 * v2.2.2 跨机器人误删修复：候选群组绝不含 group_settings 全表（那是全部机器人的群，
 * 用当前 Token 验证其他机器人的群必然 left），删除也只按 chat_id + 当前 Token 机器人
 * 集合精确删除——其他机器人对同一群组的关联不受本次同步影响。
 */
export async function fetchRealGroups(token: string): Promise<RealGroupsResult> {
  try {
    // v2.0.3：机器人 user id 直接取自 Token 前段（Telegram 官方格式 <bot_user_id>:<secret>），
    // getMe 只为 username/兜底 id
    const tokenBotId = Number(token.split(":")[0]);
    const tokenBotIdValid = Number.isSafeInteger(tokenBotId) && tokenBotId > 0;

    const mePayload = await tgRawCall<{
      ok: boolean;
      description?: string;
      result?: { id?: number; username?: string };
      error_code?: number;
    }>(token, "getMe");
    if (!mePayload.ok) {
      const description = mePayload.description ?? "网络错误";
      if (mePayload.error_code === 401) {
        return { ok: false, error: "Bot Token 无效或已被撤销（Telegram 401 Unauthorized）：请到 @BotFather → /mybots → API Token 查看当前 Token，若已撤销请重新生成并在此机器人配置中更新保存。", botUsername: null, chats: [], staleChatIds: [], unverifiedCount: 0, unverifiedReasons: [] };
      }
      return { ok: false, error: `Telegram API 错误：${description}`, botUsername: null, chats: [], staleChatIds: [], unverifiedCount: 0, unverifiedReasons: [] };
    }

    const botUsername = mePayload.result?.username ?? null;
    // 机器人自身 Telegram user id：后续 getChatMember 成员身份核验（left/kicked 判定）必需。
    // Token 前段合法时直接使用；否则回退 getMe.id，且 getMe 成功响应缺少该字段属协议异常，
    // 必须中止同步（不许带默认值继续）
    if (!tokenBotIdValid && mePayload.result?.id === undefined) {
      throw new Error(
        `Telegram getMe 响应异常：ok=true 但未返回机器人 id（username=${botUsername ?? "unknown"}），无法核验机器人群成员身份`,
      );
    }
    const botUserId: number = tokenBotIdValid ? tokenBotId : Number(mePayload.result!.id);

    // 数据库已关联群组（仅限当前 Token 对应的机器人条目）→ getChat + getChatMember 逐一验证：
    // 机器人仍在群内则用 Telegram 返回的最新群名（真实数据优先）；
    // 确认失效（群不存在 / 成员身份 left/kicked）则移除关联行并标记 stale。
    // v2.2.2 修复：候选只收「当前 Token 机器人」的关联——群组校验身份是当前 Token，
    // 把其他机器人的群拉进来验证必然误判 left，再按 chat_id 全删就是跨机器人误删事故。
    const chats = new Map<number, RealChatInfo>();
    const candidateIds = new Set<string>([...chats.keys()].map((id) => String(id)));
    const tokenBotIds = new Set<string>();
    try {
      const tokenBots = (await listBots()).filter((item) => item.token === token);
      for (const item of tokenBots) tokenBotIds.add(String(item.id));
      const links = await listGroupBotAdmins();
      for (const link of links) {
        if (tokenBotIds.has(String(link.botId))) candidateIds.add(String(link.chatId));
      }
    } catch (error) {
      console.warn("Failed to load DB group links for sync:", error);
    }

    const api = botByToken(token).api;
    const candidateList = [...candidateIds].filter((id) => !chats.has(Number(id)));
    // v2.0.3：全部候选群组的 getChat + getChatMember 并行验证（原实现逐群串行 2 次调用，
    // N 群经代理可达分钟级；现在一轮并发，总耗时 = 单次调用最大值）。
    // 确认失效的群组先收集，验证完统一移除关联行（DB 写串行，防并发写冲突）
    const staleList: { candidate: string; reason: "not_found" | "member_left" }[] = [];
    // v2.0.4：getChat 因网络错误/超时失败（非 Telegram 400）的候选 → 未验证计数；
    // 校验全失败时路由层必须向管理端透出真实原因，而不是返回「未发现群组」误导
    let unverifiedCount = 0;
    const unverifiedReasons: string[] = [];
    const verifyResults = await Promise.allSettled(
      candidateList.map(async (candidate) => {
        let chatId: bigint;
        try {
          chatId = BigInt(candidate);
        } catch {
          return;
        }
        // getChat：群是否仍真实存在（仅 Telegram 400 = chat not found 才算确认失效）
        let chatType: string | undefined;
        let chatTitle: string | undefined;
        try {
          // chat_id 必须传 string：grammY payload 走 JSON.stringify，BigInt 会直接 TypeError
          const info = await withTelegramTimeout(api.getChat(String(chatId)));
          chatTitle = (info as { title?: string }).title?.trim();
          chatType = (info as { type?: string }).type;
        } catch (error) {
          if (error instanceof GrammyError && error.error_code === 400) {
            // Telegram 400（群不存在）：历史关联确认失效 → 标记移除关联行
            staleList.push({ candidate, reason: "not_found" });
          } else {
            // 非 400（网络超时 / 429 等）：状态不确定，绝不误报 stale，绝不删除（防误删）
            // v2.0.4：计入未验证清单 —— 校验失败不能静默吞掉，否则「网络不可达」
            // 会被误读成「机器人不在任何群组」
            unverifiedCount += 1;
            if (unverifiedReasons.length < 3) {
              unverifiedReasons.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
            }
            console.warn(`getChat(${candidate}) failed:`, error instanceof Error ? error.message : error);
          }
          return;
        }
        // getChat 成功（群真实存在）→ 核验机器人成员身份：left/kicked = 机器人已不在群内
        try {
          const member = await withTelegramTimeout(api.getChatMember(String(chatId), botUserId));
          if (member.status === "left" || member.status === "kicked") {
            staleList.push({ candidate, reason: "member_left" });
            return;
          }
        } catch (error) {
          // 成员身份核验失败（网络超时 / 429 / 400 等）：状态不确定，绝不删除（防误删），
          // 保留 getChat 成功结果的原有处理
          console.warn(`getChatMember(${candidate}) failed:`, error instanceof Error ? error.message : error);
        }
        // v2.3：频道纳入真实群组列表（群组/频道统一管理；群内验证等能力差异由
        // services/chat-type.ts 能力声明在源头拦截）
        if ((chatType === "group" || chatType === "supergroup" || chatType === "channel") && chatTitle) {
          chats.set(Number(candidate), { chatId: candidate, chatTitle, chatType: chatType ?? null, source: "getchat" });
        }
      }),
    );
    for (const result of verifyResults) {
      if (result.status === "rejected") {
        console.warn("[telegram-sync] 群组验证任务异常（应已内部捕获，此为兜底日志）：", result.reason);
      }
    }
    const staleChatIds: string[] = [];
    // v2.2.2 修复：只移除当前 Token 机器人的关联行（同一群可被多个机器人同时关联，
    // 其他机器人对同一群组的关联不受本次同步影响）；Token 机器人清单加载失败时
    // staleBotIds 为空 → 删除函数直接返回 0，绝不误删（防误删方向保持一致）
    const staleBotIds = [...tokenBotIds].map((id) => BigInt(id));
    for (const stale of staleList) {
      const removed = await deleteGroupBotAdminsByChatAndBots(BigInt(stale.candidate), staleBotIds);
      if (removed === 0) continue;
      staleChatIds.push(stale.candidate);
      const reasonText =
        stale.reason === "not_found"
          ? "群组已不存在（Telegram 400 chat not found）"
          : `机器人已不在群组（成员身份 ${stale.reason === "member_left" ? "left/kicked" : "异常"}）`;
      console.info(
        `[telegram-sync] ${reasonText}，已移除失效群组关联 ${stale.candidate}（删除 ${removed} 行）`,
      );
    }

    const result: RealChatInfo[] = [...chats.values()].sort((a, b) => Number(a.chatId) - Number(b.chatId));
    return {
      ok: true,
      botUsername,
      chats: result,
      staleChatIds,
      unverifiedCount,
      unverifiedReasons,
    };
  } catch (error) {
    return { ok: false, error: describeSyncError(error), botUsername: null, chats: [], staleChatIds: [], unverifiedCount: 0, unverifiedReasons: [] };
  }
}
