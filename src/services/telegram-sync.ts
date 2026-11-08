import { Bot, GrammyError } from "grammy";
import { describeTelegramError, isTelegramRequestAlreadyHandled } from "./approval";
import {
  tgRawCall,
  telegramBotClientOptions,
  type TgOutboundDiagnostics,
} from "@/lib/telegram/transport";
import { registerInviteLinkTracking } from "@/bot/invite-link-tracking";
import {
  deleteGroupBotAdminsByChat,
  listBots,
  listGroupBotAdmins,
  listGroupSettings,
} from "@/database/operations";

/**
 * 机器人测试页与 Telegram 的真实同步通道：
 * - getUpdates 拉取 bot token 真实所在的群组（chat_id / 群名）
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
  /** 发现来源：updates=getUpdates 新发现；getchat=已关联群组经 getChat+getChatMember 验证机器人仍在群内 */
  source: "updates" | "getchat";
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

interface TgChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
}

interface TgUpdate {
  update_id: number;
  message?: { chat: TgChat };
  channel_post?: { chat: TgChat };
  my_chat_member?: { chat: TgChat };
  chat_join_request?: { chat: TgChat };
  chat_member?: { chat: TgChat };
}

/**
 * 拉取 bot token 真实所在的群组（三源合并，v1.1.1）。
 *
 * Telegram 不提供「列出全部会话」接口，单靠 getUpdates 只能看到最近未确认的更新
 * （常驻轮询会实时确认消费，导致管理端永远拉到空列表）。因此改为三源合并：
 *
 * 1. getUpdates：最近未确认更新（webhook/轮询冲突时自动自愈，读取不确认）
 * 2. 数据库已关联群组：group_bot_admins（同 Token 全部机器人条目）+ group_settings
 * 3. getChat + getChatMember 逐一验证：确认机器人仍在群内并取回最新群名（不依赖更新队列，
 *    被轮询消费过的历史群组也能找回）；确认失效（Telegram 400 群不存在，或机器人
 *    成员身份为 left/kicked）的群组移除 group_bot_admins 关联行并归入 stale 提示；
 *    网络错误/超时/429 等不确定结果一律不删（防误删）
 *
 * 机器人日常运行中收到群事件时仍会自动登记（chat-tracking → chat-registry）。
 */
export async function fetchRealGroups(token: string): Promise<RealGroupsResult> {
  try {
    // v2.0.3：机器人 user id 直接取自 Token 前段（Telegram 官方格式 <bot_user_id>:<secret>），
    // getMe（只为 username）不再阻塞 getChatMember；getMe 与 getUpdates 首轮并行发起，
    // 总耗时从「getMe→getUpdates→2N 次逐群串行验证」降到两轮并行（约省 2/3+）
    const tokenBotId = Number(token.split(":")[0]);
    const tokenBotIdValid = Number.isSafeInteger(tokenBotId) && tokenBotId > 0;

    const fetchUpdates = (): Promise<
      { ok: true; updates: TgUpdate[] } | { ok: false; errorCode?: number; description: string }
    > =>
      tgRawCall<{
        ok: boolean;
        description?: string;
        result?: TgUpdate[];
        error_code?: number;
      }>(token, "getUpdates", {
        limit: 100,
        // 注意：getUpdates 的 allowed_updates 会持久覆盖此前的声明（v1.1.3 修复）：
        // 必须包含 callback_query，否则同步之后机器人内联按钮回调将收不到
        allowed_updates: JSON.stringify([
          "message",
          "channel_post",
          "callback_query",
          "my_chat_member",
          "chat_join_request",
          "chat_member",
        ]),
      }).then((payload) =>
        payload.ok
          ? { ok: true, updates: payload.result ?? [] }
          : { ok: false, errorCode: payload.error_code, description: payload.description ?? "网络错误" },
      );

    const [mePayload, firstUpdates] = await Promise.all([
      tgRawCall<{
        ok: boolean;
        description?: string;
        result?: { id?: number; username?: string };
        error_code?: number;
      }>(token, "getMe"),
      fetchUpdates(),
    ]);
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

    let updatesResult = firstUpdates;
    let webhookToRestore: { url: string; allowedUpdates?: string; maxConnections?: number } | null = null;
    let runtimePaused = false;

    if (!updatesResult.ok && updatesResult.errorCode === 409) {
      const description = updatesResult.description;
      if (/webhook/i.test(description)) {
        // webhook 冲突：备份 → 删除 → 拉取 → 恢复
        const info = await tgRawCall<{
          ok: boolean;
          result?: { url?: string; allowed_updates?: string[]; max_connections?: number };
        }>(token, "getWebhookInfo");
        const existing = info.ok ? info.result : undefined;
        const webhookUrl = existing?.url ?? "";
        if (webhookUrl) {
          await tgRawCall<{ ok: boolean }>(token, "deleteWebhook", { drop_pending_updates: "false" });
          webhookToRestore = {
            url: webhookUrl,
            allowedUpdates: existing?.allowed_updates?.length
              ? JSON.stringify(existing.allowed_updates)
              : undefined,
            maxConnections: existing?.max_connections,
          };
        }
      } else {
        // 与本应用轮询实例冲突：暂停轮询 → 拉取 → 恢复
        runtimePaused = true;
        await pauseBotRuntimeForSync();
      }
      updatesResult = await fetchUpdates();

      // 恢复现场（无论拉取成败都要恢复）
      const restore = webhookToRestore;
      if (restore) {
        await tgRawCall<{ ok: boolean }>(token, "setWebhook", {
          url: restore.url,
          allowed_updates: restore.allowedUpdates,
          max_connections: restore.maxConnections,
        }).catch((error: unknown) => {
          console.error(
            `[telegram-sync] 同步后恢复 Webhook 失败（${restore.url}），机器人可能收不到推送:`,
            error,
          );
        });
      }
      if (runtimePaused) {
        await resumeBotRuntimeAfterSync();
      }
    }

    if (!updatesResult.ok) {
      const description = updatesResult.description;
      if (updatesResult.errorCode === 401) {
        return { ok: false, error: "Bot Token 无效或已被撤销（Telegram 401 Unauthorized）：请到 @BotFather → /mybots → API Token 查看当前 Token，若已撤销请重新生成并在此机器人配置中更新保存。", botUsername, chats: [], staleChatIds: [], unverifiedCount: 0, unverifiedReasons: [] };
      }
      if (updatesResult.errorCode === 409) {
        return {
          ok: false,
          error:
            "Telegram 返回 409：更新队列被其他消费者占用，稍后重试；机器人运行期间收到群事件时会自动登记真实群组。",
          botUsername,
          chats: [],
          staleChatIds: [],
          unverifiedCount: 0,
          unverifiedReasons: [],
        };
      }
      return { ok: false, error: `Telegram API 错误：${description}`, botUsername, chats: [], staleChatIds: [], unverifiedCount: 0, unverifiedReasons: [] };
    }

    const chats = new Map<number, RealChatInfo>();
    const collect = (chat: TgChat | undefined): void => {
      if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;
      const title = chat.title?.trim();
      if (!title) return;
      chats.set(chat.id, { chatId: String(chat.id), chatTitle: title, source: "updates" });
    };
    for (const update of updatesResult.updates) {
      collect(update.message?.chat);
      collect(update.channel_post?.chat);
      collect(update.my_chat_member?.chat);
      collect(update.chat_join_request?.chat);
      collect(update.chat_member?.chat);
    }

    // 数据库已关联群组（group_bot_admins + group_settings）→ getChat + getChatMember 逐一验证：
    // 机器人仍在群内则用 Telegram 返回的最新群名（真实数据优先）；
    // 确认失效（群不存在 / 成员身份 left/kicked）则移除关联行并标记 stale
    const candidateIds = new Set<string>([...chats.keys()].map((id) => String(id)));
    try {
      const tokenBots = (await listBots()).filter((item) => item.token === token);
      const tokenBotIds = new Set(tokenBots.map((item) => String(item.id)));
      const [links, settings] = await Promise.all([listGroupBotAdmins(), listGroupSettings()]);
      for (const link of links) {
        if (tokenBotIds.has(String(link.botId))) candidateIds.add(String(link.chatId));
      }
      for (const setting of settings) candidateIds.add(String(setting.chatId));
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
        if ((chatType === "group" || chatType === "supergroup") && chatTitle) {
          chats.set(Number(candidate), { chatId: candidate, chatTitle, source: "getchat" });
        }
      }),
    );
    for (const result of verifyResults) {
      if (result.status === "rejected") {
        console.warn("[telegram-sync] 群组验证任务异常（应已内部捕获，此为兜底日志）：", result.reason);
      }
    }
    const staleChatIds: string[] = [];
    for (const stale of staleList) {
      staleChatIds.push(stale.candidate);
      const removed = await deleteGroupBotAdminsByChat(BigInt(stale.candidate));
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

/** 同步期间暂停本应用的轮询运行时（避免 getUpdates 双消费者 409） */
async function pauseBotRuntimeForSync(): Promise<void> {
  try {
    const { stopBotRuntime } = await import("@/bot/runtime");
    const { stopAllMenuBots } = await import("@/bot/multi-runtime");
    await stopAllMenuBots().catch((error: unknown) => {
      console.error("[telegram-sync] 同步前暂停 menu bots 失败:", error);
    });
    await stopBotRuntime().catch((error: unknown) => {
      console.error("[telegram-sync] 同步前暂停主 bot 运行时失败:", error);
    });
  } catch (error) {
    console.error("[telegram-sync] 加载运行时模块失败（getUpdates 可能遭遇 409 冲突）:", error);
  }
}

/** 同步结束后恢复轮询运行时（失败必须暴露：否则机器人静默离线） */
async function resumeBotRuntimeAfterSync(): Promise<void> {
  try {
    const { startBotRuntime } = await import("@/bot/runtime");
    const { startMenuBots } = await import("@/bot/multi-runtime");
    await startBotRuntime().catch((error: unknown) => {
      console.error("[telegram-sync] 同步后恢复主 bot 运行时失败，机器人已离线:", error);
    });
    await startMenuBots().catch((error: unknown) => {
      console.error("[telegram-sync] 同步后恢复 menu bots 失败，机器人已离线:", error);
    });
  } catch (error) {
    console.error("[telegram-sync] 加载运行时模块失败，机器人未能恢复在线:", error);
  }
}
