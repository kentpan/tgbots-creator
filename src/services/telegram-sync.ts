import { Bot, GrammyError } from "grammy";
import { describeTelegramError } from "./approval";
import { parseGroupDeployState } from "./group-deploy";
import { tgRawCall, telegramBotClientOptions } from "@/lib/telegram/transport";
import {
  deleteGroupBotAdminsByChat,
  listBots,
  listGroupBotAdmins,
  listGroupSettings,
} from "@/database/operations";

/**
 * 机器人测试页与 Telegram 的真实同步通道：
 * - 发现 bot token 真实所在的群组（chat_id / 群名）
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
  botCache.set(token, bot);
  return bot;
}

export interface SyncActionResult {
  ok: boolean;
  error: string | null;
}

/** 网络层失败特征（workerd/undici/node-fetch 的真实报错文案） */
const NETWORK_ERROR_HINTS = [
  "fetch failed",
  "network connection lost",
  "network request for",
  "connect() failed",
  "connection refused",
  "connection reset",
  "econnrefused",
  "econnreset",
  "enotfound",
  "eai_again",
  "enetunreach",
  "unreachable",
];

/** 将 Telegram API 错误翻译为可读中文（网络不可达 / 超时 / Bot API 业务错误），并保留原始报错 */
export function describeSyncError(error: unknown): string {
  if (error instanceof GrammyError) {
    return describeTelegramError(error) ?? `Telegram API 错误：${error.description}`;
  }
  const raw = error instanceof Error ? error.message : String(error);
  const lowered = raw.toLowerCase();
  if (lowered.includes("timeout") || lowered.includes("abort")) {
    return `Telegram API 请求超时（${raw}）`;
  }
  if (NETWORK_ERROR_HINTS.some((hint) => lowered.includes(hint))) {
    return `无法连接 Telegram API（网络不可达：${raw}）`;
  }
  // 非网络错误（数据库/序列化/权限等）绝不冒充网络错误：原样透出真实原因
  return raw || "Telegram API 调用失败";
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

/** 真实批准加群申请（仿真用户在 Telegram 中无待审申请时由 Telegram 拒绝并透传原因） */
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
  /** 发现来源：updates=getUpdates 新发现；getchat=经 getChat+getChatMember 验证机器人仍在群内；
   *  cache=数据库已登记但本次未能完成 Telegram 校验（网络/权限原因，保留真实群组而不是隐藏） */
  source: "updates" | "getchat" | "cache";
}

export interface RealGroupsResult {
  ok: boolean;
  error?: string;
  botUsername: string | null;
  chats: RealChatInfo[];
  /** 经 getChat/getChatMember 确认失效的群组（群不存在或机器人已 left/kicked）；
   *  确认失效时已同步移除 group_bot_admins 关联行（网络错误/超时一律不删防误删） */
  staleChatIds: string[];
  /** 校验过程中的非致命问题（网络失败 / 权限不足 / 跳过 getUpdates 等）。
   *  必须透传到管理端：否则界面只会显示「未发现群组」，真实失败原因无从得知 */
  warnings: string[];
}

/** Telegram Bot API 原始响应（tgRawCall 不解包 ok/result） */
export interface TgApiPayload<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

/** Token 失效（Telegram 401）统一指引文案 */
export const INVALID_TOKEN_MESSAGE =
  "Bot Token 无效或已被撤销（Telegram 401 Unauthorized）：请到 @BotFather → /mybots → API Token 查看当前 Token，若已撤销请重新生成并在此机器人配置中更新保存。";

/**
 * 原生 Bot API 调用（统一走 transport 层 fetch：Node 出站代理 / edge 直连），
 * 网络层异常不外抛，返回 transportError 供调用方显式处理与展示。
 */
export async function callBotApi<T>(
  token: string,
  method: string,
  query: Record<string, string | number | undefined> = {},
): Promise<{ payload: TgApiPayload<T> | null; transportError: string | null }> {
  try {
    const payload = await tgRawCall<TgApiPayload<T>>(token, method, query);
    return { payload, transportError: null };
  } catch (error) {
    console.error(`[telegram-sync] Bot API 调用 ${method} 网络层失败:`, error);
    return { payload: null, transportError: describeSyncError(error) };
  }
}

/** 把 Bot API 失败响应（或网络层失败）翻译成可读中文，禁止只返回裸 description */
export function describeBotApiError(
  payload: TgApiPayload<unknown> | null,
  transportError: string | null,
  method: string,
): string {
  if (!payload) return transportError ?? `${method} 调用失败（无响应）`;
  if (payload.error_code === 401) return INVALID_TOKEN_MESSAGE;
  return `Telegram API 错误（${method} → error_code=${payload.error_code ?? "?"}）：${payload.description ?? "未知错误"}`;
}

/** 并发执行器：Cloudflare Workers 单请求最大 6 条并发出站连接，留出数据库余量按 4 并发跑 */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const current = items[cursor];
      cursor += 1;
      await worker(current);
    }
  });
  await Promise.all(runners);
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
 * 拉取 bot token 真实所在的群组（三源合并）。
 *
 * Telegram 不提供「列出全部会话」接口，单靠 getUpdates 只能看到最近未确认的更新
 * （Webhook/轮询会实时确认消费，导致管理端永远拉到空列表）。因此改为三源合并：
 *
 * 1. getUpdates：仅在「未注册 Webhook」时可用（Webhook 激活期 Telegram 直接 409）；
 *    绝不 deleteWebhook 换取更新 —— 重建时丢失 secret_token 会让回调入口密钥校验 401，
 *    机器人从此收不到任何更新（线上 edge 恒 Webhook，直接跳过本源）
 * 2. 数据库已登记群组：group_bot_admins（同 Token 全部机器人条目）+ group_settings，
 *    群名回退部署时写入 rights 的 chat_title（Telegram 真实返回）
 * 3. getChat + getChatMember 实时校验：确认机器人仍在群内并取回最新群名；确认失效
 *    （Telegram 400 群不存在 / 成员身份 left|kicked）才移除关联行并归入 stale；
 *    网络错误/超时/429 等不确定结果一律不删，且按数据库记录保留群组 + warnings 透传原因
 *
 * 机器人日常运行中收到群事件时仍会自动登记（chat-tracking → chat-registry）。
 */
export async function fetchRealGroups(token: string): Promise<RealGroupsResult> {
  const warnings: string[] = [];
  try {
    // v2.0.3：机器人 user id 直接取自 Token 前段（Telegram 官方格式 <bot_user_id>:<secret>），
    // 省掉一次 getMe 等待；Token 格式异常时回退 getMe.id（缺失即中止，绝不带默认值继续）
    const tokenBotId = Number(token.split(":")[0]);
    const tokenBotIdValid = Number.isSafeInteger(tokenBotId) && tokenBotId > 0;

    const me = await callBotApi<{ id?: number; username?: string }>(token, "getMe");
    if (me.payload === null) {
      return {
        ok: false,
        error: me.transportError ?? "getMe 调用失败",
        botUsername: null,
        chats: [],
        staleChatIds: [],
        warnings,
      };
    }
    if (me.payload.ok !== true) {
      const description = me.payload.description ?? "未知错误";
      if (me.payload.error_code === 401) {
        return {
          ok: false,
          error:
            "Bot Token 无效或已被撤销（Telegram 401 Unauthorized）：请到 @BotFather → /mybots → API Token 查看当前 Token，若已撤销请重新生成并在此机器人配置中更新保存。",
          botUsername: null,
          chats: [],
          staleChatIds: [],
          warnings,
        };
      }
      return {
        ok: false,
        error: `Telegram API 错误：${description}（error_code=${me.payload.error_code ?? "?"}）`,
        botUsername: null,
        chats: [],
        staleChatIds: [],
        warnings,
      };
    }

    const botUsername = me.payload.result?.username ?? null;
    const meId = me.payload.result?.id;
    if (!tokenBotIdValid && typeof meId !== "number") {
      throw new Error(
        `Telegram getMe 响应异常：ok=true 但未返回机器人 id（username=${botUsername ?? "unknown"}），无法核验机器人群成员身份`,
      );
    }
    const botUserId: number = tokenBotIdValid ? tokenBotId : Number(meId);

    const chats = new Map<string, RealChatInfo>();

    // —— 源①：getUpdates（仅「无 Webhook」时可行）——
    // Webhook 激活期 Telegram 直接拒绝 getUpdates（409）；而「删 Webhook → 拉取 → 重建」
    // 会打断线上机器人收信：重建时若漏掉 secret_token，本应用回调入口的密钥校验会 401
    // 拒绝全部更新（机器人从此收不到任何消息，群组再也无法自动登记）。所以这里绝不
    // 改动已注册的 Webhook —— 线上（edge 恒 Webhook）走源②③。
    const hook = await callBotApi<{ url?: string }>(token, "getWebhookInfo");
    const webhookUrl = (hook.payload?.result?.url ?? "").trim();
    if (hook.payload === null) {
      warnings.push(`读取 Webhook 状态失败（${hook.transportError}），本次跳过 getUpdates 发现`);
    } else if (hook.payload.ok !== true) {
      warnings.push(
        `读取 Webhook 状态失败（${hook.payload.error_code ?? "?"} ${hook.payload.description ?? "未知错误"}），本次跳过 getUpdates 发现`,
      );
    } else if (webhookUrl) {
      warnings.push(
        "机器人运行在 Webhook 模式：Telegram 不保留可拉取的更新队列，本次改用「数据库已登记群组 + 实时校验」发现群组",
      );
    } else {
      const updates = await pullUpdates(token, warnings);
      const collect = (chat: TgChat | undefined): void => {
        if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;
        const title = chat.title?.trim();
        if (!title) return;
        chats.set(String(chat.id), { chatId: String(chat.id), chatTitle: title, source: "updates" });
      };
      for (const update of updates) {
        collect(update.message?.chat);
        collect(update.channel_post?.chat);
        collect(update.my_chat_member?.chat);
        collect(update.chat_join_request?.chat);
        collect(update.chat_member?.chat);
      }
    }

    // —— 源②：数据库已登记群组 ——
    // group_bot_admins（同 Token 全部机器人条目）+ group_settings（管理端保存过的群组）。
    // 群名回退优先级：group_settings.chat_title > 部署时写入 rights 的 chat_title（Telegram 真实返回）
    const dbTitles = new Map<string, string>();
    const candidateIds = new Set<string>(chats.keys());
    try {
      const tokenBots = (await listBots()).filter((item) => item.token === token);
      const tokenBotIds = new Set(tokenBots.map((item) => String(item.id)));
      const [links, settings] = await Promise.all([listGroupBotAdmins(), listGroupSettings()]);
      for (const setting of settings) {
        const title = setting.chatTitle?.trim();
        if (title) dbTitles.set(String(setting.chatId), title);
        candidateIds.add(String(setting.chatId));
      }
      for (const link of links) {
        const chatId = String(link.chatId);
        if (link.status === "active" && tokenBotIds.has(String(link.botId))) candidateIds.add(chatId);
        if (dbTitles.has(chatId)) continue;
        const deployedTitle = parseGroupDeployState(link.rights)?.chat_title?.trim();
        if (deployedTitle) dbTitles.set(chatId, deployedTitle);
      }
    } catch (error) {
      console.error("[telegram-sync] 读取数据库群组关联失败:", error);
      warnings.push(`读取数据库群组关联失败：${describeSyncError(error)}`);
    }

    // —— 源③：getChat + getChatMember 实时校验（并发 4，规避 edge 单请求 6 连接上限）——
    // 机器人仍在群内 → 用 Telegram 返回的最新群名；
    // 确认失效（400 群不存在 / 成员身份 left|kicked）→ 移除关联行并归入 stale；
    // 其余失败（网络 / 429 / 权限）→ 保留数据库记录（source=cache）+ warnings，绝不静默丢弃
    const staleList: { candidate: string; reason: "not_found" | "member_left" }[] = [];
    const verifyTargets = [...candidateIds].filter((id) => !chats.has(id));
    await runWithConcurrency(verifyTargets, 4, async (candidate) => {
      const knownTitle = dbTitles.get(candidate) ?? "";
      const label = knownTitle || candidate;
      const keepFromCache = (title: string): void => {
        if (title) chats.set(candidate, { chatId: candidate, chatTitle: title, source: "cache" });
      };

      const chat = await callBotApi<{ id?: number; type?: string; title?: string }>(token, "getChat", {
        chat_id: candidate,
      });
      if (chat.payload === null) {
        warnings.push(`群组「${label}」校验失败（${chat.transportError}），已按数据库记录保留`);
        keepFromCache(knownTitle);
        return;
      }
      if (chat.payload.ok !== true) {
        const description = chat.payload.description ?? "未知错误";
        if (
          chat.payload.error_code === 400 &&
          /not found|chat_id is empty|invalid chat id/i.test(description)
        ) {
          staleList.push({ candidate, reason: "not_found" });
          return;
        }
        warnings.push(
          `群组「${label}」读取失败（${chat.payload.error_code ?? "?"} ${description}），已按数据库记录保留`,
        );
        keepFromCache(knownTitle);
        return;
      }

      const info = chat.payload.result ?? {};
      const chatTitle = (info.title ?? "").trim() || knownTitle;
      const chatType = info.type;

      const member = await callBotApi<{ status?: string }>(token, "getChatMember", {
        chat_id: candidate,
        user_id: botUserId,
      });
      if (member.payload === null) {
        warnings.push(`群组「${label}」成员身份核验失败（${member.transportError}），已按数据库记录保留`);
        keepFromCache(chatTitle);
        return;
      }
      if (member.payload.ok !== true) {
        const description = member.payload.description ?? "未知错误";
        if (member.payload.error_code === 400 && /member not found|user not found/i.test(description)) {
          staleList.push({ candidate, reason: "member_left" });
          return;
        }
        warnings.push(
          `群组「${label}」成员身份核验失败（${member.payload.error_code ?? "?"} ${description}），已按数据库记录保留`,
        );
        keepFromCache(chatTitle);
        return;
      }

      const status = member.payload.result?.status ?? "";
      if (status === "left" || status === "kicked") {
        staleList.push({ candidate, reason: "member_left" });
        return;
      }
      if ((chatType === "group" || chatType === "supergroup") && chatTitle) {
        chats.set(candidate, { chatId: candidate, chatTitle, source: "getchat" });
      } else if (chatTitle) {
        chats.set(candidate, { chatId: candidate, chatTitle, source: "cache" });
      } else {
        warnings.push(`群组 ${candidate} 无法读取群名（type=${chatType ?? "unknown"}）`);
      }
    });

    const staleChatIds: string[] = [];
    for (const stale of staleList) {
      staleChatIds.push(stale.candidate);
      const removed = await deleteGroupBotAdminsByChat(BigInt(stale.candidate));
      const reasonText =
        stale.reason === "not_found"
          ? "群组已不存在（Telegram 400 chat not found）"
          : "机器人已不在群组（成员身份 left/kicked）";
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
      warnings,
    };
  } catch (error) {
    console.error("[telegram-sync] fetchRealGroups 异常:", error);
    return {
      ok: false,
      error: describeSyncError(error),
      botUsername: null,
      chats: [],
      staleChatIds: [],
      warnings,
    };
  }
}

/**
 * 拉取待处理更新（仅在无 Webhook 时调用）。
 * 409 只可能是「本应用自己的轮询实例正在消费」—— 暂停轮询 → 拉取 → 恢复，
 * 恢复失败必须显式报错（否则机器人静默离线）。
 */
async function pullUpdates(token: string, warnings: string[]): Promise<TgUpdate[]> {
  const query = {
    limit: 100,
    // getUpdates 的 allowed_updates 会持久覆盖此前的声明（v1.1.3 修复）：
    // 必须包含 callback_query，否则同步之后机器人内联按钮回调将收不到
    allowed_updates: JSON.stringify([
      "message",
      "channel_post",
      "callback_query",
      "my_chat_member",
      "chat_join_request",
      "chat_member",
    ]),
  };
  const first = await callBotApi<TgUpdate[]>(token, "getUpdates", query);
  if (first.payload === null) {
    warnings.push(`getUpdates 失败（${first.transportError}），本次跳过更新发现`);
    return [];
  }
  if (first.payload.ok === true) return first.payload.result ?? [];
  if (first.payload.error_code !== 409) {
    warnings.push(
      `getUpdates 失败（${first.payload.error_code ?? "?"} ${first.payload.description ?? "未知错误"}），本次跳过更新发现`,
    );
    return [];
  }

  await pauseBotRuntimeForSync();
  try {
    const retry = await callBotApi<TgUpdate[]>(token, "getUpdates", query);
    if (retry.payload?.ok === true) return retry.payload.result ?? [];
    warnings.push(
      `getUpdates 在暂停本地轮询后仍失败（${retry.payload?.error_code ?? "?"} ${retry.payload?.description ?? retry.transportError ?? "未知错误"}）`,
    );
    return [];
  } finally {
    await resumeBotRuntimeAfterSync();
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
