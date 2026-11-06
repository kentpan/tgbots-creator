import { Bot, GrammyError } from "grammy";
import { describeTelegramError } from "./approval";
import { parseGroupDeployState } from "./group-deploy";
import { tgRawCall, telegramBotClientOptions } from "@/lib/telegram/transport";
import {
  TRANSPORT_SETTING_KEYS,
  botWebhookSecret,
  botWebhookUrl,
  isEdgeRuntime,
} from "@/lib/telegram/runtime-mode";
import {
  deleteGroupBotAdminsByChat,
  getAppSetting,
  listBots,
  listGroupBotAdmins,
  listGroupSettings,
  type BotRow,
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

interface TgWebhookInfo {
  url?: string;
  has_custom_certificate?: boolean;
  pending_update_count?: number;
  last_error_date?: number;
  last_error_message?: string;
  max_connections?: number;
  allowed_updates?: string[];
}

/**
 * getUpdates 参数。allowed_updates 会持久覆盖此前的声明（v1.1.3 修复）：
 * 必须包含 callback_query，否则同步之后机器人内联按钮回调将收不到。
 */
const UPDATES_QUERY = {
  limit: 100,
  allowed_updates: JSON.stringify([
    "message",
    "channel_post",
    "callback_query",
    "my_chat_member",
    "chat_join_request",
    "chat_member",
  ]),
} as const;

/** 积压更新重放上限：Cloudflare 单请求执行时间有限，超出部分提示用户再点一次同步 */
const MAX_REPLAY_UPDATES = 30;

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

    // —— Token 下的机器人条目：Webhook 密钥派生与更新重放都依赖 botId ——
    let tokenBots: BotRow[] = [];
    try {
      tokenBots = (await listBots()).filter((item) => item.token === token);
    } catch (error) {
      console.error("[telegram-sync] 读取机器人列表失败:", error);
      warnings.push(`读取机器人列表失败：${describeSyncError(error)}`);
    }

    // —— Webhook 现状：线上 edge 唯一的入站通道（加群申请/入群事件都从这里来）——
    const hook = await callBotApi<TgWebhookInfo>(token, "getWebhookInfo");
    const webhook: TgWebhookInfo = hook.payload?.ok === true ? (hook.payload.result ?? {}) : {};
    if (hook.payload === null) {
      warnings.push(`读取 Webhook 状态失败（${hook.transportError}）`);
    } else if (hook.payload.ok !== true) {
      warnings.push(
        `读取 Webhook 状态失败（${hook.payload.error_code ?? "?"} ${hook.payload.description ?? "未知错误"}）`,
      );
    }
    const webhookUrl = (webhook.url ?? "").trim();
    if (webhook.last_error_message?.trim()) {
      warnings.push(
        `Webhook 最近投递失败：${webhook.last_error_message.trim()}${
          webhook.pending_update_count ? `（积压 ${webhook.pending_update_count} 条更新）` : ""
        }`,
      );
    }
    if (webhookUrl) {
      // 域名漂移诊断：换过域名/部署地址后 Webhook 仍指向旧主机 → 更新全部推给旧站点，机器人静默
      try {
        const configuredBase = ((await getAppSetting(TRANSPORT_SETTING_KEYS.webhookBaseUrl)) ?? "").trim();
        const configuredHost = configuredBase ? new URL(configuredBase).host : "";
        const actualHost = new URL(webhookUrl).host;
        if (configuredHost && configuredHost !== actualHost) {
          warnings.push(
            `Webhook 指向 ${actualHost}，与系统设置中的 Base URL（${configuredHost}）不一致：请在「系统设置 → 传输模式」重新保存一次指向当前站点`,
          );
        }
      } catch (error) {
        console.error("[telegram-sync] 校验 Webhook 域名与配置失败:", error);
      }
    }

    // —— 源①：更新队列 ——
    // 新群组只在「机器人被拉进群」那一刻的 my_chat_member 更新里可见（Telegram 没有
    // 列出全部会话的接口）。Webhook 激活期 getUpdates 恒 409，所以这里临时摘除 Webhook
    // 拉取积压更新，随后立即用「派生密钥」重建 —— 顺带修好历史上 secret 丢失导致
    // 回调 401、机器人彻底哑掉的现场；拉到的更新再重放给机器人实例，加群申请不会被吞咽。
    const updates = await harvestUpdates({ token, webhook, webhookUrl, tokenBots, warnings });
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
    await replayUpdates(updates, webhookUrl, tokenBots, warnings);

    // —— 源②：数据库已登记群组 ——
    // 两类候选必须区分开（否则会用本机器人的视角误删别的机器人的关联）：
    //   linkedIds   = group_bot_admins 中「本 Token 的机器人条目」关联的群 → 校验失败即确认失效
    //   settingsOnly= group_settings 里其它群 → 只用来补群名，Telegram 说「查不到」不代表群失效
    const dbTitles = new Map<string, string>();
    const linkedIds = new Set<string>();
    const candidateIds = new Set<string>(chats.keys());
    try {
      const tokenBotIds = new Set(tokenBots.map((item) => String(item.id)));
      const [links, settings] = await Promise.all([listGroupBotAdmins(), listGroupSettings()]);
      for (const setting of settings) {
        const chatId = String(setting.chatId);
        const title = setting.chatTitle?.trim();
        if (title) dbTitles.set(chatId, title);
        candidateIds.add(chatId);
      }
      for (const link of links) {
        const chatId = String(link.chatId);
        if (link.status === "active" && tokenBotIds.has(String(link.botId))) {
          candidateIds.add(chatId);
          linkedIds.add(chatId);
        }
        if (dbTitles.has(chatId)) continue;
        const deployedTitle = parseGroupDeployState(link.rights)?.chat_title?.trim();
        if (deployedTitle) dbTitles.set(chatId, deployedTitle);
      }
    } catch (error) {
      console.error("[telegram-sync] 读取数据库群组关联失败:", error);
      warnings.push(`读取数据库群组关联失败：${describeSyncError(error)}`);
    }

    // —— 源③：getChat + getChatMember 实时校验（并发 4，规避 edge 单请求 6 连接上限）——
    // linked（本 Token 机器人关联的群）：机器人仍在群内 → 用 Telegram 返回的最新群名；
    //   确认失效（400 群不存在 / 成员身份 left|kicked）→ 移除关联行并归入 stale；
    //   其余失败（网络 / 429 / 权限）→ 保留数据库记录（source=cache）+ warnings，绝不静默丢弃
    // settingsOnly（别的机器人/手工登记的群）：只用来给群名兜底；本机器人查不到不算失效，
    //   更不允许据此删除关联行（历史实现会用它误删其它机器人的群）
    const staleList: { candidate: string; reason: "not_found" | "member_left" }[] = [];
    const verifyTargets = [...candidateIds].filter((id) => !chats.has(id));
    await runWithConcurrency(verifyTargets, 4, async (candidate) => {
      const knownTitle = dbTitles.get(candidate) ?? "";
      const label = knownTitle || candidate;
      const linked = linkedIds.has(candidate);
      const keepFromCache = (title: string): void => {
        if (linked && title) chats.set(candidate, { chatId: candidate, chatTitle: title, source: "cache" });
      };

      const chat = await callBotApi<{ id?: number; type?: string; title?: string }>(token, "getChat", {
        chat_id: candidate,
      });
      if (chat.payload === null) {
        if (linked) {
          warnings.push(`群组「${label}」校验失败（${chat.transportError}），已按数据库记录保留`);
          keepFromCache(knownTitle);
        } else {
          console.warn(`[telegram-sync] 群组 ${candidate}（未关联本 Token）校验失败：${chat.transportError}`);
        }
        return;
      }
      if (chat.payload.ok !== true) {
        const description = chat.payload.description ?? "未知错误";
        const notFound = chat.payload.error_code === 400 && /not found|chat_id is empty|invalid chat id/i.test(description);
        if (notFound) {
          if (linked) staleList.push({ candidate, reason: "not_found" });
          else console.info(`[telegram-sync] 群组 ${candidate} 本机器人不可见（非本 Token 关联群），跳过`);
          return;
        }
        if (linked) {
          warnings.push(
            `群组「${label}」读取失败（${chat.payload.error_code ?? "?"} ${description}），已按数据库记录保留`,
          );
          keepFromCache(knownTitle);
        } else {
          console.warn(
            `[telegram-sync] 群组 ${candidate}（未关联本 Token）读取失败：${chat.payload.error_code ?? "?"} ${description}`,
          );
        }
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
        if (linked) {
          warnings.push(`群组「${label}」成员身份核验失败（${member.transportError}），已按数据库记录保留`);
          keepFromCache(chatTitle);
        }
        return;
      }
      if (member.payload.ok !== true) {
        const description = member.payload.description ?? "未知错误";
        const leftGroup = member.payload.error_code === 400 && /member not found|user not found/i.test(description);
        if (leftGroup) {
          if (linked) staleList.push({ candidate, reason: "member_left" });
          else console.info(`[telegram-sync] 群组 ${candidate} 本机器人不是成员（非本 Token 关联群），跳过`);
          return;
        }
        if (linked) {
          warnings.push(
            `群组「${label}」成员身份核验失败（${member.payload.error_code ?? "?"} ${description}），已按数据库记录保留`,
          );
          keepFromCache(chatTitle);
        } else {
          console.warn(
            `[telegram-sync] 群组 ${candidate}（未关联本 Token）成员核验失败：${member.payload.error_code ?? "?"} ${description}`,
          );
        }
        return;
      }

      const status = member.payload.result?.status ?? "";
      if (status === "left" || status === "kicked") {
        if (linked) staleList.push({ candidate, reason: "member_left" });
        else console.info(`[telegram-sync] 群组 ${candidate} 本机器人状态 ${status}（非本 Token 关联群），跳过`);
        return;
      }
      if ((chatType === "group" || chatType === "supergroup") && chatTitle) {
        chats.set(candidate, { chatId: candidate, chatTitle, source: "getchat" });
      } else if (chatTitle && linked) {
        chats.set(candidate, { chatId: candidate, chatTitle, source: "cache" });
      } else if (!chatTitle) {
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

/** 本应用注册的 Webhook 形态：<base>/api/telegram/webhook 或 <base>/api/telegram/webhook/<botId> */
const MANAGED_WEBHOOK_PATTERN = /\/api\/telegram\/webhook(?:\/([^/?#]+))?$/;

/** 从 Webhook 地址解析 botId 段（旧版无 botId 的地址返回空串） */
function webhookPathBotId(url: string): string {
  return MANAGED_WEBHOOK_PATTERN.exec(url)?.[1] ?? "";
}

/**
 * edge 形态下补回缺失的 Webhook（无 Base URL 无法回调，直接提示去系统设置配置）。
 * Node 形态不调用本函数 —— 那里轮询才是主通道，挂 Webhook 反而会打断 getUpdates。
 */
async function restoreMissingWebhook(
  token: string,
  tokenBots: BotRow[],
  warnings: string[],
): Promise<void> {
  const botIdText = tokenBots[0] ? String(tokenBots[0].id) : "";
  if (!botIdText) {
    warnings.push("机器人条目缺失（Token 未登记在 bots 表），无法重建 Webhook");
    return;
  }
  const base = ((await getAppSetting(TRANSPORT_SETTING_KEYS.webhookBaseUrl)) ?? "").trim();
  if (!/^https:\/\/.+/.test(base)) {
    warnings.push(
      "机器人当前没有 Webhook，且系统设置里未配置 https 的 Webhook Base URL —— edge 环境收不到任何更新，请先到「系统设置 → 传输模式」保存站点地址",
    );
    return;
  }
  const url = botWebhookUrl(base, botIdText);
  const registered = await callBotApi<boolean>(token, "setWebhook", {
    url,
    secret_token: botWebhookSecret(botIdText, token),
    allowed_updates: UPDATES_QUERY.allowed_updates,
    drop_pending_updates: "false",
  });
  if (registered.payload?.ok === true) {
    console.info(`[telegram-sync] 已补建 Webhook：${url}`);
    warnings.push(`机器人原先没有 Webhook（收不到任何更新），已按系统设置补建：${url}`);
  } else {
    const detail = registered.payload
      ? `${registered.payload.error_code ?? "?"} ${registered.payload.description ?? ""}`
      : registered.transportError;
    console.error(`[telegram-sync] 补建 Webhook 失败（${url}）: ${detail}`);
    warnings.push(`⚠️ 补建 Webhook 失败（${detail}），机器人仍收不到更新`);
  }
}

/**
 * 拉取待处理更新（源①）。三种现场：
 * - 无 Webhook：直接 getUpdates；409 = 本应用轮询实例正在消费 → 暂停轮询 → 拉取 → 恢复
 * - 本应用 Webhook：临时 deleteWebhook → getUpdates → **带 secret_token 重建**（自愈历史丢失）
 * - 外部 Webhook：不碰（改动别人的推送链路会直接打断线上机器人），仅提示
 *
 * 调用方拿到更新后必须重放（replayUpdates），否则被 getUpdates 确认掉的加群申请
 * 就再也不会投递到 Webhook，等于把用户的申请吃掉了。
 */
async function harvestUpdates(params: {
  token: string;
  webhook: TgWebhookInfo;
  webhookUrl: string;
  tokenBots: BotRow[];
  warnings: string[];
}): Promise<TgUpdate[]> {
  const { token, webhook, webhookUrl, tokenBots, warnings } = params;
  if (!webhookUrl) {
    const updates = await pullUpdates(token, warnings);
    // edge 无常驻进程，没有 Webhook 等于机器人彻底离线（收不到加群申请/入群事件）：
    // 用系统设置里的 Base URL 把 Webhook 补回来，否则「同步」永远只能看到数据库里的旧群
    if (isEdgeRuntime()) await restoreMissingWebhook(token, tokenBots, warnings);
    return updates;
  }

  if (!MANAGED_WEBHOOK_PATTERN.test(webhookUrl)) {
    warnings.push(`机器人的 Webhook 指向外部地址（${webhookUrl}），为避免打断线上推送，本次不接管更新队列`);
    return [];
  }

  const botIdFromUrl = webhookPathBotId(webhookUrl);
  const secretBotId = botIdFromUrl || (tokenBots[0] ? String(tokenBots[0].id) : "");
  const secret = secretBotId ? botWebhookSecret(secretBotId, token) : "";

  const removed = await callBotApi<boolean>(token, "deleteWebhook", { drop_pending_updates: "false" });
  if (removed.payload?.ok !== true) {
    warnings.push(
      `临时摘除 Webhook 失败（${removed.payload ? `${removed.payload.error_code ?? "?"} ${removed.payload.description ?? ""}` : removed.transportError}），本次无法发现新群组`,
    );
    return [];
  }

  let updates: TgUpdate[] = [];
  try {
    const pulled = await callBotApi<TgUpdate[]>(token, "getUpdates", UPDATES_QUERY);
    if (pulled.payload?.ok === true) {
      updates = pulled.payload.result ?? [];
    } else {
      warnings.push(
        `getUpdates 失败（${pulled.payload ? `${pulled.payload.error_code ?? "?"} ${pulled.payload.description ?? ""}` : pulled.transportError}），本次无法发现新群组`,
      );
    }
  } finally {
    // 必须带 secret_token 重建：这是回调入口密钥校验的唯一来源，漏掉等于让机器人静音
    const restored = await callBotApi<boolean>(token, "setWebhook", {
      url: webhookUrl,
      secret_token: secret || undefined,
      allowed_updates: webhook.allowed_updates?.length
        ? JSON.stringify(webhook.allowed_updates)
        : UPDATES_QUERY.allowed_updates,
      max_connections: webhook.max_connections,
      drop_pending_updates: "false",
    });
    if (restored.payload?.ok !== true) {
      const detail = restored.payload
        ? `${restored.payload.error_code ?? "?"} ${restored.payload.description ?? ""}`
        : restored.transportError;
      console.error(`[telegram-sync] 重建 Webhook 失败（${webhookUrl}）: ${detail}`);
      warnings.push(`⚠️ 重建 Webhook 失败（${detail}），机器人将收不到推送，请立即到系统设置重新保存传输模式`);
    } else if (!secret) {
      console.error(`[telegram-sync] 无法推导 Webhook 密钥（botId=${secretBotId || "unknown"}）`);
      warnings.push("⚠️ 未能确定机器人 ID，Webhook 已按无密钥重建，回调可能被密钥校验拒绝");
    } else {
      console.info(`[telegram-sync] Webhook 已用派生密钥重建：${webhookUrl}`);
    }
  }
  return updates;
}

/**
 * 把 getUpdates 拉到的更新重放进机器人实例（含加群申请/入群事件）。
 * getUpdates 会确认并消费这些更新，不重放就等于丢弃 —— 用户申请入群将永远得不到响应。
 */
async function replayUpdates(
  updates: TgUpdate[],
  webhookUrl: string,
  tokenBots: BotRow[],
  warnings: string[],
): Promise<void> {
  if (updates.length === 0) return;
  const botIdFromUrl = webhookPathBotId(webhookUrl);
  const target = tokenBots.find((item) => String(item.id) === botIdFromUrl) ?? tokenBots[0];
  if (!target) {
    warnings.push(`机器人条目缺失（Token 未登记在 bots 表），${updates.length} 条积压更新未处理`);
    return;
  }
  const batch = updates.slice(0, MAX_REPLAY_UPDATES);
  if (updates.length > batch.length) {
    warnings.push(
      `积压更新 ${updates.length} 条，本次只重放前 ${batch.length} 条，请稍后再点一次「同步真实群组」处理剩余`,
    );
  }
  try {
    const { acquireMenuBot } = await import("@/bot/multi-runtime");
    const handle = await acquireMenuBot(target.id);
    if (!handle) {
      warnings.push("无法初始化机器人实例，积压更新未处理");
      return;
    }
    if (!handle.bot.isInited()) await handle.bot.init();
    let failed = 0;
    for (const update of batch) {
      try {
        await handle.bot.handleUpdate(update as Parameters<typeof handle.bot.handleUpdate>[0]);
      } catch (error) {
        failed += 1;
        console.error(`[telegram-sync] 重放更新 ${update.update_id} 失败:`, error);
      }
    }
    if (failed > 0) {
      warnings.push(`积压更新重放失败 ${failed}/${batch.length} 条（详见服务端日志）`);
    } else {
      console.info(`[telegram-sync] 已重放 ${batch.length} 条积压更新`);
    }
  } catch (error) {
    console.error("[telegram-sync] 重放积压更新异常:", error);
    warnings.push(`积压更新重放异常：${describeSyncError(error)}`);
  }
}

/**
 * 无 Webhook 时的 getUpdates：409 只可能是「本应用自己的轮询实例正在消费」——
 * 暂停轮询 → 拉取 → 恢复，恢复失败必须显式报错（否则机器人静默离线）。
 */
async function pullUpdates(token: string, warnings: string[]): Promise<TgUpdate[]> {
  const first = await callBotApi<TgUpdate[]>(token, "getUpdates", UPDATES_QUERY);
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
    const retry = await callBotApi<TgUpdate[]>(token, "getUpdates", UPDATES_QUERY);
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
