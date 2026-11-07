/**
 * 镜像中继面核心（仅 Node）：GramJS userbot 与目标 bot 的一切 MTProto 交互收拢于此。
 * 同一模块两种拉起：
 * - instrumentation 内嵌（凭据齐全时 startMirrorRelayIfConfigured 自动注册 inprocess relay）
 * - scripts/mirror-relay.ts 独立进程（remote 模式宿主，附加 HTTP /v1/* 契约）
 * 本文件禁止被 Edge bundle 静态引用 —— 用户面仅经 src/bot/mirror/relay.ts 的
 * globalThis 注册表 / HMAC HTTP 与本模块交互。
 */
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { TelegramClient, Api } from "telegram";
import { CustomFile } from "telegram/client/uploads";
import { StringSession } from "telegram/sessions";
import { NewMessage } from "telegram/events";
import type { NewMessageEvent } from "telegram/events";
import { EditedMessage } from "telegram/events/EditedMessage";
import type { EditedMessageEvent } from "telegram/events/EditedMessage";
import type { CustomMessage } from "telegram/tl/custom/message";
import {
  registerInprocessRelay,
  setRelayMaintenance,
  unregisterInprocessRelay,
  mirrorSecret,
  signRelayRequest,
  verifyRelaySignature,
  type MirrorRelay,
} from "@/bot/mirror/relay";
import { readMirrorCredentials, readProxyBotToken } from "@/bot/mirror/config";
import { generateCallbackKey, buildProxyInlineKeyboard, type TlMarkup, type TlButton } from "@/bot/mirror/keyboard";
import { sanitizeText, sanitizeUrl } from "@/bot/mirror/sanitize";
import {
  createMirrorJob,
  finishMirrorJob,
  listMirrorJobs,
  putMirrorCallback,
  upsertMirrorTarget,
  logMirrorEvent,
} from "@/bot/mirror/store";
import type { BotAnswer, TargetProfile, UpstreamMedia } from "@/bot/mirror/types";

// ============ 配置 ============

export interface RelayConfig {
  listen: string;
  secret: string;
  proxyBotToken: string;
  targetBot: string;
  apiId: number;
  apiHash: string;
  sessionString: string;
  dbPath: string;
  appBaseUrl: string;
  serializeMode: "global" | "per_user";
  actionTimeoutSeconds: number;
  mediaInlineMaxMb: number;
  rewriteRules: Record<string, string>;
}

export async function readRelayConfig(overrides: Partial<RelayConfig> = {}): Promise<RelayConfig | null> {
  const envCreds = readMirrorCredentials();
  // 凭据优先级：显式 overrides（bot 行绑定的开发者账号）→ 环境变量；session 只走环境变量
  const apiId = overrides.apiId ?? envCreds?.apiId ?? 0;
  const apiHash = overrides.apiHash ?? envCreds?.apiHash ?? "";
  const sessionString = overrides.sessionString ?? envCreds?.sessionString ?? "";
  const targetBot = (overrides.targetBot ?? process.env.MIRROR_TARGET_BOT ?? "").trim().replace(/^@/, "");
  if (!apiId || !apiHash || !sessionString || !targetBot) return null;
  const proxyBotToken = readProxyBotToken();
  if (!proxyBotToken) {
    throw new Error(
      "[mirror-relay] MIRROR_PROXY_BOT_TOKEN 未配置：中继面下行需要壳 bot token 直发用户",
    );
  }
  return {
    listen: overrides.listen ?? process.env.MIRROR_LISTEN ?? "127.0.0.1:8787",
    secret: overrides.secret ?? (await mirrorSecret()),
    proxyBotToken,
    targetBot,
    apiId: overrides.apiId ?? apiId,
    apiHash: overrides.apiHash ?? apiHash,
    sessionString: overrides.sessionString ?? sessionString,
    dbPath: overrides.dbPath ?? process.env.MIRROR_RELAY_DB ?? "./.data/mirror-relay.db",
    appBaseUrl: overrides.appBaseUrl ?? (process.env.MIRROR_APP_BASE_URL ?? "").trim().replace(/\/+$/, ""),
    serializeMode: overrides.serializeMode ?? "global",
    actionTimeoutSeconds: overrides.actionTimeoutSeconds ?? 60,
    mediaInlineMaxMb: overrides.mediaInlineMaxMb ?? 20,
    rewriteRules: overrides.rewriteRules ?? {},
  };
}

// ============ relay 本地 SQLite（out_map，中继面自持自用） ============

interface OutMapRow {
  targetMsgId: number;
  proxyChatId: number;
  proxyMsgId: number;
  userId: number | null;
  kind: string | null;
}

class OutMap {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS out_map (
        target_msg_id INTEGER PRIMARY KEY,
        proxy_chat_id INTEGER NOT NULL,
        proxy_msg_id  INTEGER NOT NULL,
        user_id       INTEGER,
        kind          TEXT,
        created_at    INTEGER NOT NULL
      );
    `);
  }

  save(row: Omit<OutMapRow, "kind"> & { kind?: string }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO out_map (target_msg_id, proxy_chat_id, proxy_msg_id, user_id, kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(row.targetMsgId, row.proxyChatId, row.proxyMsgId, row.userId ?? null, row.kind ?? null, Date.now());
  }

  get(targetMsgId: number): OutMapRow | null {
    const row = this.db
      .prepare(`SELECT * FROM out_map WHERE target_msg_id = ?`)
      .get(targetMsgId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      targetMsgId: Number(row.target_msg_id),
      proxyChatId: Number(row.proxy_chat_id),
      proxyMsgId: Number(row.proxy_msg_id),
      userId: row.user_id === null ? null : Number(row.user_id),
      kind: row.kind === null ? null : String(row.kind),
    };
  }
}

// ============ 串行队列 ============

const chains = new Map<string, Promise<unknown>>();

export function enqueue<T>(mode: "global" | "per_user", userId: number, fn: () => Promise<T>): Promise<T> {
  const key = mode === "global" ? "global" : String(userId);
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(
    key,
    next.finally(() => {
      if (chains.get(key) === next) chains.delete(key);
    }),
  );
  return next;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`动作超时（${label}，${ms}ms）`)), ms),
    ),
  ]);
}

// ============ AppSink：应用侧写入口（inprocess 直调 / remote HMAC HTTP） ============

export interface AppSink {
  saveCallback(input: {
    proxyKey: string;
    targetMsgId: number;
    buttonText: string;
    buttonData: Uint8Array | null;
    staleAfterSeconds: number;
  }): Promise<void>;
  createJob(input: { targetMsgId: number; mediaKind: string; userId: number | null }): Promise<number | null>;
  finishJob(id: number, status: string, error?: string | null): Promise<void>;
  readonly kind: "inprocess" | "remote";
}

class InprocessAppSink implements AppSink {
  readonly kind = "inprocess" as const;

  async saveCallback(input: Parameters<AppSink["saveCallback"]>[0]): Promise<void> {
    await putMirrorCallback({
      proxyKey: input.proxyKey,
      targetMsgId: input.targetMsgId,
      buttonText: input.buttonText,
      buttonData: input.buttonData,
      staleAfterSeconds: input.staleAfterSeconds,
    });
  }

  async createJob(input: { targetMsgId: number; mediaKind: string; userId: number | null }): Promise<number | null> {
    const { createMirrorJob: create } = await import("@/bot/mirror/store");
    return create({ targetMsgId: input.targetMsgId, mediaKind: input.mediaKind, userId: input.userId });
  }

  async finishJob(id: number, status: string, error?: string | null): Promise<void> {
    await finishMirrorJob(id, status, error);
  }
}

class RemoteAppSink implements AppSink {
  readonly kind = "remote" as const;

  constructor(private appBaseUrl: string) {}

  private async post<T>(pathname: string, payload: Record<string, unknown>): Promise<T> {
    const body = JSON.stringify(payload);
    const timestamp = String(Date.now());
    const response = await fetch(`${this.appBaseUrl}${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mirror-timestamp": timestamp,
        "x-mirror-signature": await signRelayRequest(timestamp, body),
      },
      body,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`app ${pathname} HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    return (await response.json()) as T;
  }

  async saveCallback(input: Parameters<AppSink["saveCallback"]>[0]): Promise<void> {
    await this.post("/api/v1/mirror/callbacks", {
      proxyKey: input.proxyKey,
      targetMsgId: input.targetMsgId,
      buttonText: input.buttonText,
      buttonData: input.buttonData ? Buffer.from(input.buttonData).toString("base64") : null,
      staleAfterSeconds: input.staleAfterSeconds,
    });
  }

  async createJob(input: { targetMsgId: number; mediaKind: string; userId: number | null }): Promise<number | null> {
    const result = await this.post<{ id: number | null }>("/api/v1/mirror/jobs", input);
    return result.id;
  }

  async finishJob(id: number, status: string, error?: string | null): Promise<void> {
    await this.post("/api/v1/mirror/jobs/finish", { id, status, error: error ?? null });
  }
}

function pickSink(cfg: RelayConfig): AppSink {
  // 同进程（instrumentation 内嵌）直调应用侧 store；独立进程走 HMAC HTTP
  if (process.env.MIRROR_RELAY_EMBEDDED === "1" || !cfg.appBaseUrl) {
    return new InprocessAppSink();
  }
  return new RemoteAppSink(cfg.appBaseUrl);
}

// ============ Bot API 直发（中继面持有壳 bot token） ============

interface BotApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

async function botApi<T>(token: string, method: string, payload: Record<string, unknown>): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await response.json()) as BotApiResponse<T>;
  if (!data.ok || data.result === undefined) {
    throw new Error(`Bot API ${method} 失败: ${data.description ?? `HTTP ${response.status}`}`);
  }
  return data.result;
}

interface SentMessage {
  chat_id: number;
  message_id: number;
}

async function botApiSendMedia(
  token: string,
  chatId: number,
  media: UpstreamMedia,
  markup: Record<string, unknown> | undefined,
): Promise<SentMessage> {
  const methodByKind: Record<UpstreamMedia["kind"], string> = {
    photo: "sendPhoto",
    document: "sendDocument",
    video: "sendVideo",
    audio: "sendAudio",
    voice: "sendVoice",
    video_note: "sendVideoNote",
    sticker: "sendDocument",
    animation: "sendAnimation",
  };
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append(
    methodByKind[media.kind] === "sendPhoto" ? "photo" : methodByKind[media.kind],
    new Blob([new Uint8Array(media.bytes)], { type: media.mimeType ?? "application/octet-stream" }),
    media.filename ?? "file",
  );
  if (media.caption) form.append("caption", media.caption);
  if (markup) form.append("reply_markup", JSON.stringify(markup));
  const response = await fetch(`https://api.telegram.org/bot${token}/${methodByKind[media.kind]}`, {
    method: "POST",
    body: form,
  });
  const data = (await response.json()) as BotApiResponse<SentMessage>;
  if (!data.ok || !data.result) {
    throw new Error(`Bot API ${methodByKind[media.kind]} 失败: ${data.description ?? `HTTP ${response.status}`}`);
  }
  return data.result;
}

// ============ TL → 中立键盘结构 ============

function toNeutralMarkup(replyMarkup: unknown): TlMarkup | null {
  if (!replyMarkup || typeof replyMarkup !== "object") return null;
  const rows = (replyMarkup as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) return null;
  const neutralRows: TlButton[][] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const neutralRow: TlButton[] = [];
    for (const raw of row) {
      if (!raw || typeof raw !== "object") continue;
      const className = (raw as { className?: string }).className ?? "";
      const button = raw as { text?: unknown; url?: unknown; data?: unknown; query?: unknown };
      const text = typeof button.text === "string" ? button.text : "";
      if (className === "KeyboardButtonCallback" && button.data instanceof Uint8Array) {
        neutralRow.push({ kind: "callback", text, data: button.data });
      } else if (className === "KeyboardButtonUrl" && typeof button.url === "string") {
        neutralRow.push({ kind: "url", text, url: button.url });
      } else if (className === "KeyboardButtonUrlAuth" && typeof button.url === "string") {
        neutralRow.push({ kind: "url_auth", text, url: button.url, buttonId: 0 });
      } else if (className === "KeyboardButtonSwitchInline" && typeof button.query === "string") {
        neutralRow.push({ kind: "switch_inline", text, query: button.query, samePeer: false });
      } else {
        neutralRow.push({ kind: "unsupported", text });
      }
    }
    if (neutralRow.length > 0) neutralRows.push(neutralRow);
  }
  return neutralRows.length > 0 ? { rows: neutralRows } : null;
}

function extractMediaBytes(msg: CustomMessage): { mime: string; filename: string; kind: UpstreamMedia["kind"] } | null {
  const media = msg.media;
  if (!media) return null;
  const className = (media as { className?: string }).className ?? "";
  const document = (media as { document?: { mimeType?: string; size?: number | bigint } }).document;
  const mime = document?.mimeType ?? "application/octet-stream";
  let kind: UpstreamMedia["kind"] = "document";
  if (className === "MessageMediaPhoto") kind = "photo";
  const filename = kind === "photo" ? `photo-${msg.id}.jpg` : `file-${msg.id}`;
  return { mime, filename, kind };
}

// ============ 归属模型（多终端用户共享 userbot 会话） ============

interface Ownership {
  pending: { userId: number; chatId: number; until: number } | null;
  lastActive: { userId: number; chatId: number } | null;
}

// ============ 中继面主体 ============

export interface MirrorRelayRuntime {
  relay: MirrorRelay;
  stop(): Promise<void>;
  startHttpServer(): Promise<void>;
}

let runtimeInstance: MirrorRelayRuntime | null = null;

export function getRelayRuntime(): MirrorRelayRuntime | null {
  return runtimeInstance;
}

export async function startMirrorRelay(config: RelayConfig): Promise<MirrorRelayRuntime> {
  if (runtimeInstance) return runtimeInstance;

  const outMap = new OutMap(config.dbPath);
  const sink = pickSink(config);
  const ownership: Ownership = { pending: null, lastActive: null };

  const client = new TelegramClient(
    new StringSession(config.sessionString),
    config.apiId,
    config.apiHash,
    { connectionRetries: 5, autoReconnect: true },
  );
  await client.connect();
  const entity = await client.getEntity(config.targetBot);
  const targetId = Number(entity.id.toString());
  const sanitizeOptions = { targetBot: config.targetBot, proxyBot: "", rewriteRules: config.rewriteRules };

  console.log(`[mirror-relay] MTProto 已连接（target=@${config.targetBot} id=${targetId}）`);

  function noteActivity(userId: number, chatId: number): void {
    ownership.lastActive = { userId, chatId };
    ownership.pending = { userId, chatId, until: Date.now() + config.actionTimeoutSeconds * 1000 };
  }

  function recipientForDownstream(): { userId: number; chatId: number } | null {
    if (ownership.pending && ownership.pending.until > Date.now()) {
      return { userId: ownership.pending.userId, chatId: ownership.pending.chatId };
    }
    return ownership.lastActive;
  }

  async function rebuildAndRegisterKeys(
    msg: CustomMessage,
  ): Promise<Record<string, unknown> | undefined> {
    const neutral = toNeutralMarkup(msg.replyMarkup);
    if (!neutral) return undefined;
    const staleAfter = config.actionTimeoutSeconds * 4;
    const markup = buildProxyInlineKeyboard(neutral, {
      resolveCallbackKey: (button) => {
        const key = generateCallbackKey((size) => new Uint8Array(crypto.getRandomValues(new Uint8Array(size))));
        const keyText = key;
        // 异步写表：键盘组装同步返回 key，写入失败由 catch 记录
        void sink
          .saveCallback({
            proxyKey: keyText,
            targetMsgId: msg.id,
            buttonText: button.text,
            buttonData: button.data,
            staleAfterSeconds: staleAfter,
          })
          .catch((error: unknown) => {
            console.error(`[mirror-relay] mirror_callbacks 回写失败（msg=${msg.id}）:`, error);
          });
        return keyText;
      },
      sanitizeUrl: (url) => sanitizeUrl(url, sanitizeOptions),
    });
    return markup ? (markup as unknown as Record<string, unknown>) : undefined;
  }

  async function deliverMedia(
    recipient: { userId: number; chatId: number },
    msg: CustomMessage,
    markup: Record<string, unknown> | undefined,
  ): Promise<void> {
    const info = extractMediaBytes(msg);
    if (!info) return;
    const documentSize = (msg.media as { document?: { size?: number | bigint } } | undefined)?.document?.size;
    const photoSize = (msg.media as { photo?: { size?: number | bigint }[] | undefined } | undefined)?.photo;
    const estimated = Number(
      documentSize ?? (photoSize && photoSize.length > 0 ? photoSize[photoSize.length - 1].size : 0) ?? 0,
    );
    const jobEstimateMb = estimated / (1024 * 1024);
    const isLarge = jobEstimateMb > config.mediaInlineMaxMb;
    let jobId: number | null = null;
    if (isLarge) {
      jobId = await sink.createJob({ targetMsgId: msg.id, mediaKind: info.kind, userId: recipient.userId });
    }
    try {
      const buffer = (await msg.downloadMedia({})) as Buffer | undefined;
      if (!buffer) {
        throw new Error(`downloadMedia 返回空（targetMsgId=${msg.id}）`);
      }
      const bytes = new Uint8Array(buffer);
      const sizeMb = bytes.byteLength / (1024 * 1024);
      if (sizeMb > 50) {
        if (jobId !== null) await sink.finishJob(jobId, "failed", `${sizeMb.toFixed(1)}MB 超过 Bot API 50MB 上传上限`);
        await botApi(config.proxyBotToken, "sendMessage", {
          chat_id: recipient.chatId,
          text: "⚠️ 文件过大（>50MB），Bot API 无法上传；如需大文件镜像请部署本地 Bot API Server。",
        });
        return;
      }
      const caption = sanitizeText(msg.message ?? "", sanitizeOptions) || undefined;
      const sent = await botApiSendMedia(config.proxyBotToken, recipient.chatId, {
        kind: info.kind,
        bytes,
        filename: info.filename,
        mimeType: info.mime,
        caption,
      }, markup);
      outMap.save({
        targetMsgId: msg.id,
        proxyChatId: sent.chat_id,
        proxyMsgId: sent.message_id,
        userId: recipient.userId,
        kind: info.kind,
      });
      if (jobId !== null) await sink.finishJob(jobId, "done", null);
    } catch (error) {
      console.error(`[mirror-relay] 媒体下行失败（targetMsgId=${msg.id}）:`, error);
      if (jobId !== null) {
        await sink.finishJob(jobId, "failed", error instanceof Error ? error.message : String(error)).catch(() => undefined);
      }
      await logMirrorEvent({
        userId: recipient.userId,
        direction: "error",
        event: "downstream_media_failed",
        payload: { targetMsgId: msg.id, error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  const onNewMessage = async (event: NewMessageEvent): Promise<void> => {
    const msg = event.message as CustomMessage;
    const recipient = recipientForDownstream();
    if (!recipient) {
      console.warn(`[mirror-relay] 下行消息无可归属用户（targetMsgId=${msg.id}），已丢弃`);
      await logMirrorEvent({ direction: "outbound", event: "orphan_downstream", payload: { targetMsgId: msg.id } });
      return;
    }
    const markup = await rebuildAndRegisterKeys(msg);
    if (msg.media) {
      await deliverMedia(recipient, msg, markup);
      return;
    }
    const text = sanitizeText(msg.message ?? "", sanitizeOptions);
    const sent = await botApi<SentMessage>(config.proxyBotToken, "sendMessage", {
      chat_id: recipient.chatId,
      text: text || "（空消息）",
      reply_markup: markup,
    });
    outMap.save({
      targetMsgId: msg.id,
      proxyChatId: sent.chat_id,
      proxyMsgId: sent.message_id,
      userId: recipient.userId,
      kind: "text",
    });
    await logMirrorEvent({
      userId: recipient.userId,
      direction: "outbound",
      event: "mirrored",
      payload: { targetMsgId: msg.id, proxyMsgId: sent.message_id },
    });
  };

  const onEditedMessage = async (event: EditedMessageEvent): Promise<void> => {
    const msg = event.message as CustomMessage;
    const hit = outMap.get(msg.id);
    if (!hit) return;
    const markup = await rebuildAndRegisterKeys(msg);
    const text = sanitizeText(msg.message ?? "", sanitizeOptions);
    if (msg.media) {
      await deliverMedia({ userId: hit.userId ?? 0, chatId: hit.proxyChatId }, msg, markup);
      return;
    }
    await botApi(config.proxyBotToken, "editMessageText", {
      chat_id: hit.proxyChatId,
      message_id: hit.proxyMsgId,
      text: text || "（空消息）",
      reply_markup: markup,
    });
    await logMirrorEvent({
      userId: hit.userId,
      direction: "outbound",
      event: "mirrored_edit",
      payload: { targetMsgId: msg.id, proxyMsgId: hit.proxyMsgId },
    });
  };

  client.addEventHandler(onNewMessage, new NewMessage({ fromUsers: [targetId] }));
  client.addEventHandler(onEditedMessage, new EditedMessage({ fromUsers: [targetId] }));
  client.addEventHandler((update) => {
    const className = (update as { className?: string }).className ?? "";
    if (className === "UpdateAuthKey" || className === "UpdateAuthorization") {
      console.error("[mirror-relay] 收到授权变更事件，session 可能失效");
    }
  });

  const relay: MirrorRelay = {
    kind: "inprocess",
    async send(userChatId, userId, text) {
      noteActivity(userId, userChatId);
      await enqueue(config.serializeMode, userId, async () => {
        await withTimeout(
          client.sendMessage(entity, { message: text }),
          config.actionTimeoutSeconds * 1000,
          "send",
        );
        await logMirrorEvent({ userId, direction: "inbound", event: "sent_to_target", payload: { length: text.length } });
      });
    },
    async sendMedia(userChatId, userId, media) {
      noteActivity(userId, userChatId);
      await enqueue(config.serializeMode, userId, async () => {
        await withTimeout(
          client.sendFile(entity, {
            file: new CustomFile(media.filename ?? "file", media.bytes.byteLength, "", Buffer.from(media.bytes)),
            forceDocument: media.kind === "document" || media.kind === "sticker",
            caption: media.caption,
          }),
          config.actionTimeoutSeconds * 2 * 1000,
          "sendMedia",
        );
        await logMirrorEvent({ userId, direction: "inbound", event: "media_sent_to_target", payload: { kind: media.kind, size: media.bytes.byteLength } });
      });
    },
    async click(targetMsgId, buttonText) {
      const owner = recipientForDownstream();
      if (owner) noteActivity(owner.userId, owner.chatId);
      return enqueue(config.serializeMode, owner?.userId ?? 0, async () => {
        const [targetMessage] = await client.getMessages(entity, { ids: [targetMsgId] });
        if (!targetMessage) {
          console.warn(`[mirror-relay] 代点失败：目标消息不存在（id=${targetMsgId}）`);
          return null;
        }
        const answer = await withTimeout(
          targetMessage.click({ text: buttonText }),
          config.actionTimeoutSeconds * 1000,
          "click",
        );
        if (!answer) return null;
        const result: BotAnswer = {
          alert: (answer as { alert?: boolean }).alert,
          message: (answer as { message?: string }).message,
          url: (answer as { url?: string }).url,
        };
        await logMirrorEvent({
          userId: owner?.userId ?? null,
          direction: "click",
          event: "clicked_on_target",
          payload: { targetMsgId, buttonText, hasAnswer: Boolean(answer) },
        });
        return result;
      });
    },
    async probe() {
      const full = await client.invoke(new Api.users.GetFullUser({ id: entity }));
      const botInfo = full.fullUser.botInfo;
      const commands = (botInfo?.commands ?? []).map((cmd) => ({
        command: cmd.command,
        description: cmd.description,
      }));
      const profile: TargetProfile = {
        username: config.targetBot,
        title:
          (botInfo as unknown as { title?: string })?.title ??
          (entity as { firstName?: string }).firstName ??
          config.targetBot,
        description: (full.fullUser as { about?: string }).about ?? "",
        commands,
      };
      await upsertMirrorTarget({
        username: config.targetBot,
        title: profile.title,
        description: profile.description,
        commands: profile.commands,
      });
      return profile;
    },
    async health() {
      return client.connected === true;
    },
  };

  async function processPendingJobs(): Promise<void> {
    const jobs = await listMirrorJobs("pending", 5);
    for (const job of jobs) {
      try {
        const [targetMessage] = await client.getMessages(entity, { ids: [job.targetMsgId] });
        if (!targetMessage) {
          await sink.finishJob(job.id, "failed", `目标消息不存在（id=${job.targetMsgId}）`);
          continue;
        }
        const recipient = job.proxyChatId !== null ? { userId: job.userId ?? 0, chatId: job.proxyChatId } : recipientForDownstream();
        if (!recipient) {
          await sink.finishJob(job.id, "failed", "无可归属用户");
          continue;
        }
        await deliverMedia(recipient, targetMessage as CustomMessage, undefined);
        await sink.finishJob(job.id, "done", null);
      } catch (error) {
        console.error(`[mirror-relay] L2 作业处理失败（job=${job.id}）:`, error);
        await sink.finishJob(job.id, "failed", error instanceof Error ? error.message : String(error)).catch(() => undefined);
      }
    }
  }

  const jobTimer = setInterval(() => {
    void processPendingJobs();
  }, 60_000);
  jobTimer.unref();

  const httpServer = http.createServer((req, res) => {
    void handleRelayHttp(req, res, relay, config, ownership);
  });

  runtimeInstance = {
    relay,
    async stop() {
      clearInterval(jobTimer);
      unregisterInprocessRelay("运行时停止");
      if (httpServer.listening) {
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
      await client.disconnect();
      if (runtimeInstance === thisRuntime) {
        runtimeInstance = null;
      }
    },
    async startHttpServer() {
      const [host, portText] = config.listen.split(":");
      const port = Number(portText) || 8787;
      await new Promise<void>((resolve) => httpServer.listen(port, host || "127.0.0.1", resolve));
      console.log(`[mirror-relay] HTTP 契约已监听 ${config.listen}（remote 模式宿主）`);
    },
  };
  const thisRuntime = runtimeInstance;

  // session 失效自停：GramJS 连接错误回调
  client.addEventHandler((update) => {
    const text = JSON.stringify(update);
    if (text.includes("AUTH_KEY_UNREGISTERED") || text.includes("AUTH_KEY_INVALID")) {
      void (async () => {
        console.error("[mirror-relay] session 已失效（AUTH_KEY_UNREGISTERED），中继面自停并进入维护态");
        setRelayMaintenance(true);
        await logMirrorEvent({ direction: "error", event: "session_invalid", payload: { targetBot: config.targetBot } });
        await runtimeInstance?.stop();
      })();
    }
  });

  return runtimeInstance;
}

/** 凭据齐全时自动拉起（instrumentation / resolveRelay 兜底调用） */
export async function startMirrorRelayIfConfigured(overrides: Partial<RelayConfig> = {}): Promise<MirrorRelay | null> {
  if (runtimeInstance) return runtimeInstance.relay;
  let config: RelayConfig;
  try {
    const parsed = await readRelayConfig(overrides);
    if (!parsed) return null;
    config = parsed;
  } catch (error) {
    console.error("[mirror-relay] 配置读取失败，中继面未启动:", error);
    return null;
  }
  try {
    const runtime = await startMirrorRelay(config);
    registerInprocessRelay(runtime.relay);
    return runtime.relay;
  } catch (error) {
    console.error("[mirror-relay] 启动失败:", error);
    setRelayMaintenance(true);
    await logMirrorEvent({
      direction: "error",
      event: "relay_start_failed",
      payload: { error: error instanceof Error ? error.message : String(error) },
    });
    return null;
  }
}

// ============ HTTP 契约（remote 模式） ============

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    if (chunks.reduce((sum, c) => sum + c.length, 0) > 10 * 1024 * 1024) {
      throw new Error("请求体超过 10MB 上限");
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

function respond(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function handleRelayHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  relay: MirrorRelay,
  config: RelayConfig,
  ownership: Ownership,
): Promise<void> {
  const url = req.url ?? "";
  const pathname = url.split("?")[0];
  try {
    const timestamp = String(req.headers["x-mirror-timestamp"] ?? "");
    const signature = String(req.headers["x-mirror-signature"] ?? "");
    const body = await readBody(req);
    if (pathname !== "/v1/health") {
      if (!(await verifyRelaySignature(timestamp, body, signature))) {
        console.error(`[mirror-relay] HMAC 验签失败（${pathname}）`);
        respond(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
    }

    if (req.method === "GET" && pathname === "/v1/health") {
      const ok = await relay.health();
      respond(res, 200, { ok, lastActivity: ownership.lastActive?.userId ?? null });
      return;
    }
    if (req.method !== "POST") {
      respond(res, 405, { ok: false, error: "method not allowed" });
      return;
    }
    const payload = body ? (JSON.parse(body) as Record<string, unknown>) : {};

    if (pathname === "/v1/send") {
      const userId = Number(payload.userId);
      const chatId = Number(payload.chatId);
      const text = String(payload.text ?? "");
      await relay.send(chatId, userId, text);
      respond(res, 200, { ok: true });
      return;
    }
    if (pathname === "/v1/media") {
      const userId = Number(payload.userId);
      const chatId = Number(payload.chatId);
      const dataBase64 = String(payload.dataBase64 ?? "");
      await relay.sendMedia(chatId, userId, {
        kind: (payload.kind as UpstreamMedia["kind"]) ?? "document",
        bytes: new Uint8Array(Buffer.from(dataBase64, "base64")),
        filename: payload.filename === null ? undefined : String(payload.filename ?? "file"),
        caption: payload.caption === null ? undefined : (payload.caption as string | undefined),
        mimeType: payload.mimeType === null ? undefined : (payload.mimeType as string | undefined),
      });
      respond(res, 200, { ok: true });
      return;
    }
    if (pathname === "/v1/click") {
      const targetMsgId = Number(payload.targetMsgId);
      const buttonText = String(payload.buttonText ?? "");
      const answer = await relay.click(targetMsgId, buttonText);
      respond(res, 200, answer ?? {});
      return;
    }
    if (pathname === "/v1/probe") {
      const profile = await relay.probe();
      respond(res, 200, profile);
      return;
    }
    respond(res, 404, { ok: false, error: "not found" });
  } catch (error) {
    console.error(`[mirror-relay] HTTP 处理失败（${pathname}）:`, error);
    respond(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}
