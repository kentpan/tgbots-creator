import { createHmac } from "node:crypto";
import { detectPlane } from "./env";
import {
  logMirrorEvent,
  type MirrorLogDirection,
} from "./store";
import type {
  BotAnswer,
  MirrorConfig,
  ResolvedMirrorConfig,
  TargetProfile,
  UpstreamMedia,
} from "./types";
import { resolveMirrorConfig } from "./types";
import { mirrorSecret, readMirrorCredentials } from "./config";

// ============ MirrorRelay 接口 ============

export interface MirrorRelay {
  readonly kind: "inprocess" | "remote";
  send(userChatId: number, userId: number, text: string): Promise<void>;
  sendMedia(userChatId: number, userId: number, media: UpstreamMedia): Promise<void>;
  click(targetMsgId: number, buttonText: string): Promise<BotAnswer | null>;
  probe(): Promise<TargetProfile>;
  health(): Promise<boolean>;
}

// ============ 中继面进程注册表（inprocess 路径的桥） ============

const globalForRelay = globalThis as unknown as {
  tguardMirrorRelay?: MirrorRelay;
  tguardMirrorRelayMaintenance?: boolean;
};

export function registerInprocessRelay(relay: MirrorRelay): void {
  globalForRelay.tguardMirrorRelay = relay;
  console.log("[mirror] inprocess relay 已注册（本进程 MTProto 中继可用）");
}

export function unregisterInprocessRelay(reason: string): void {
  if (globalForRelay.tguardMirrorRelay) {
    globalForRelay.tguardMirrorRelay = undefined;
    console.warn(`[mirror] inprocess relay 已注销: ${reason}`);
  }
}

export function isRelayMaintenance(): boolean {
  return globalForRelay.tguardMirrorRelayMaintenance === true;
}

export function setRelayMaintenance(value: boolean): void {
  globalForRelay.tguardMirrorRelayMaintenance = value;
}

// ============ HMAC 签名（remote 模式鉴权） ============

export { mirrorSecret } from "./config";

export async function signRelayRequest(timestamp: string, body: string): Promise<string> {
  const secret = await mirrorSecret();
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

function verifyTimestampDrift(timestamp: string): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  return Math.abs(Date.now() - ts) <= 5 * 60 * 1000;
}

export async function verifyRelaySignature(timestamp: string, body: string, signature: string): Promise<boolean> {
  if (!verifyTimestampDrift(timestamp)) return false;
  const expected = await signRelayRequest(timestamp, body);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

// ============ RemoteRelay：HMAC HTTP ============

const REMOTE_TIMEOUT_MS = 30_000;

class RemoteRelay implements MirrorRelay {
  readonly kind = "remote" as const;

  constructor(
    private readonly baseUrl: string,
    private readonly healthTimeoutMs = 3000,
  ) {}

  private async request<T>(
    path: string,
    payload: Record<string, unknown>,
    timeoutMs = REMOTE_TIMEOUT_MS,
  ): Promise<T> {
    const body = JSON.stringify(payload);
    const timestamp = String(Date.now());
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mirror-timestamp": timestamp,
        "x-mirror-signature": await signRelayRequest(timestamp, body),
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`relay ${path} HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    return (await response.json()) as T;
  }

  async send(userChatId: number, userId: number, text: string): Promise<void> {
    await this.request("/v1/send", { userId, chatId: userChatId, text });
  }

  async sendMedia(userChatId: number, userId: number, media: UpstreamMedia): Promise<void> {
    await this.request("/v1/media", {
      userId,
      chatId: userChatId,
      kind: media.kind,
      filename: media.filename ?? null,
      caption: media.caption ?? null,
      mimeType: media.mimeType ?? null,
      dataBase64: Buffer.from(media.bytes).toString("base64"),
    });
  }

  async click(targetMsgId: number, buttonText: string): Promise<BotAnswer | null> {
    const result = await this.request<BotAnswer | null>("/v1/click", {
      targetMsgId,
      buttonText,
    });
    return result ?? null;
  }

  async probe(): Promise<TargetProfile> {
    return this.request<TargetProfile>("/v1/probe", {});
  }

  async health(): Promise<boolean> {
    try {
      const timestamp = String(Date.now());
      const response = await fetch(`${this.baseUrl}/v1/health`, {
        headers: {
          "x-mirror-timestamp": timestamp,
          "x-mirror-signature": await signRelayRequest(timestamp, ""),
        },
        signal: AbortSignal.timeout(this.healthTimeoutMs),
      });
      if (!response.ok) return false;
      const data = (await response.json()) as { ok?: boolean };
      return data.ok === true;
    } catch (error) {
      console.error(`[mirror] remote relay health 探测失败（${this.baseUrl}）:`, error);
      return false;
    }
  }
}

// ============ InProcessRelay：直调本进程注册表 ============

function inprocessRelay(): MirrorRelay | null {
  return globalForRelay.tguardMirrorRelay ?? null;
}

class InProcessRelayHandle implements MirrorRelay {
  readonly kind = "inprocess" as const;

  private relay(): MirrorRelay {
    const relay = inprocessRelay();
    if (!relay) throw new Error("inprocess relay 已注销");
    return relay;
  }

  async send(userChatId: number, userId: number, text: string): Promise<void> {
    await this.relay().send(userChatId, userId, text);
  }

  async sendMedia(userChatId: number, userId: number, media: UpstreamMedia): Promise<void> {
    await this.relay().sendMedia(userChatId, userId, media);
  }

  async click(targetMsgId: number, buttonText: string): Promise<BotAnswer | null> {
    return this.relay().click(targetMsgId, buttonText);
  }

  async probe(): Promise<TargetProfile> {
    return this.relay().probe();
  }

  async health(): Promise<boolean> {
    return inprocessRelay() !== null && (await inprocessRelay()!.health());
  }
}

// ============ resolveRelay：决策树 + 故障切换 ============

export type RelayStatus = "inprocess" | "remote" | "degraded";

interface RelayHolder {
  cfg: ResolvedMirrorConfig;
  active: MirrorRelay | null;
  activeKind: RelayStatus;
  /** 恢复探测：失效路径连续成功计数（滞回防抖，3 次切回） */
  recoverySuccesses: number;
  lastAlertAt: number;
  failoverAt: number | null;
  /** 懒解析的进行中 Promise（防冷启动并发重复建链） */
  resolving: Promise<RelayHolder> | null;
}

const globalForHolders = globalThis as unknown as {
  tguardMirrorRelayHolders?: Map<string, RelayHolder>;
};

function holders(): Map<string, RelayHolder> {
  if (!globalForHolders.tguardMirrorRelayHolders) {
    globalForHolders.tguardMirrorRelayHolders = new Map();
  }
  return globalForHolders.tguardMirrorRelayHolders;
}

const ALERT_WINDOW_MS = 10 * 60 * 1000;
const HEALTH_CACHE_TTL_MS = 5 * 60 * 1000;

const globalForHealth = globalThis as unknown as {
  tguardMirrorRemoteHealth?: { ok: boolean; at: number };
};

async function remoteHealthCached(baseUrl: string): Promise<boolean> {
  const cached = globalForHealth.tguardMirrorRemoteHealth;
  if (cached && Date.now() - cached.at < HEALTH_CACHE_TTL_MS) return cached.ok;
  const relay = new RemoteRelay(baseUrl);
  const ok = await relay.health();
  globalForHealth.tguardMirrorRemoteHealth = { ok, at: Date.now() };
  return ok;
}

async function buildRemote(cfg: ResolvedMirrorConfig): Promise<MirrorRelay | null> {
  if (!cfg.relayBaseUrl) return null;
  const ok = await remoteHealthCached(cfg.relayBaseUrl);
  if (!ok) {
    console.warn(`[mirror] remote relay 健康检查未通过（${cfg.relayBaseUrl}），本路径不可用`);
    return null;
  }
  return new RemoteRelay(cfg.relayBaseUrl);
}

async function startInprocessIfCreds(cfg: ResolvedMirrorConfig): Promise<MirrorRelay | null> {
  const existing = inprocessRelay();
  if (existing) return new InProcessRelayHandle();
  if (detectPlane() !== "node") return null;
  // 凭据来源优先级：环境变量（MIRROR_API_ID/HASH）→ bot 行绑定的开发者账号（developer_accounts）
  // session_string 恒走环境变量（等同账号完全控制权，不入库）
  const envCreds = readMirrorCredentials();
  let apiId = envCreds?.apiId ?? 0;
  let apiHash = envCreds?.apiHash ?? "";
  if ((!apiId || !apiHash) && cfg.developerAccountId) {
    const { getDeveloperAccount } = await import("@/database/operations");
    const account = await getDeveloperAccount(BigInt(cfg.developerAccountId));
    if (account) {
      apiId = apiId || Number(account.apiId);
      apiHash = apiHash || String(account.apiHash);
    } else {
      console.warn(`[mirror] 绑定的开发者账号不存在（id=${cfg.developerAccountId}），回退 remote/降级`);
    }
  }
  const session = envCreds?.sessionString ?? "";
  if (!apiId || !apiHash || !session) {
    if (cfg.developerAccountId) {
      console.warn(
        "[mirror] inprocess 凭据不完整：需要 MIRROR_SESSION_STRING（npx tsx scripts/mirror-login.ts 生成），" +
          "api_id/api_hash 已取自绑定的开发者账号",
      );
    }
    return null;
  }
  // 凭据齐全但中继面尚未启动：instrumentation 启动时会拉起；此处触发兜底拉起。
  // 动态 import 保持懒加载：telegram（GramJS）只进独立 chunk，edge 平面在上方
  // detectPlane() !== "node" 已短路、永不执行到这里，workerd 不会加载该 chunk。
  const { startMirrorRelayIfConfigured } = await import("@/relay/mirror-relay");
  const relay = await startMirrorRelayIfConfigured({
    targetBot: cfg.targetBot,
    apiId,
    apiHash,
  });
  return relay ? new InProcessRelayHandle() : null;
}

async function noneDegraded(cfg: ResolvedMirrorConfig, reason: string): Promise<RelayHolder> {
  console.error(`[mirror] 中继不可用，进入受控降级（target=@${cfg.targetBot}）: ${reason}`);
  await logMirrorEvent({
    direction: "error",
    event: "relay_degraded",
    payload: { targetBot: cfg.targetBot, reason },
  });
  return {
    cfg,
    active: null,
    activeKind: "degraded",
    recoverySuccesses: 0,
    lastAlertAt: 0,
    failoverAt: null,
    resolving: null,
  };
}

async function resolveHolder(cfg: ResolvedMirrorConfig): Promise<RelayHolder> {
  const plane = detectPlane();
  const want = cfg.relayMode;

  const tryRemote = async (): Promise<MirrorRelay | null> =>
    cfg.relayBaseUrl ? buildRemote(cfg) : null;
  const tryInprocess = async (): Promise<MirrorRelay | null> =>
    plane === "node" ? startInprocessIfCreds(cfg) : null;

  if (want === "remote") {
    const remote = await tryRemote();
    if (remote) return holder(cfg, remote, "remote");
    return noneDegraded(cfg, "已强制 remote 但 relay 不可用");
  }
  if (want === "inprocess") {
    const inprocess = await tryInprocess();
    if (inprocess) return holder(cfg, inprocess, "inprocess");
    const remote = await tryRemote();
    if (remote) return holder(cfg, remote, "remote");
    return noneDegraded(cfg, "已强制 inprocess 且无 remote 备选");
  }

  // auto：平面默认优先 + 能力回退
  const preferred = plane === "edge" ? await tryRemote() : await tryInprocess();
  const fallback = plane === "edge" ? await tryInprocess() : await tryRemote();
  if (preferred) return holder(cfg, preferred, preferred.kind);
  if (fallback) {
    console.warn(`[mirror] 优先中继路径不可用，自动切换到 ${fallback.kind}（target=@${cfg.targetBot}）`);
    return holder(cfg, fallback, fallback.kind);
  }
  return noneDegraded(cfg, `无可用中继（plane=${plane}，凭据与 relayBaseUrl 均缺失）`);
}

function holder(cfg: ResolvedMirrorConfig, relay: MirrorRelay, kind: RelayStatus): RelayHolder {
  return {
    cfg,
    active: relay,
    activeKind: kind,
    recoverySuccesses: 0,
    lastAlertAt: 0,
    failoverAt: null,
    resolving: null,
  };
}

export interface ResolvedRelay {
  relay: MirrorRelay | null;
  status: RelayStatus;
  cfg: ResolvedMirrorConfig;
}

/**
 * 中继解析入口：每个镜像 bot 冷启动/首个 update 时调用并缓存直至失效。
 * 活跃中继失效时自动在备选路径间切换，双路径皆失进入受控降级。
 */
export async function resolveRelay(cfg: MirrorConfig): Promise<ResolvedRelay> {
  const resolved = resolveMirrorConfig(cfg);
  const key = resolved.targetBot;
  const existing = holders().get(key);
  if (existing?.active) {
    return { relay: existing.active, status: existing.activeKind, cfg: resolved };
  }
  if (existing?.resolving) {
    const done = await existing.resolving;
    return { relay: done.active, status: done.activeKind, cfg: resolved };
  }
  const task = resolveHolder(resolved);
  if (existing) existing.resolving = task;
  const holderResult = await task;
  if (existing) {
    Object.assign(existing, holderResult, { resolving: null });
  } else {
    holders().set(key, holderResult);
  }
  return { relay: holderResult.active, status: holderResult.activeKind, cfg: resolved };
}

/** 调用方使用中继时的统一包装：失败自动切换备选路径，并限频告警 */
export async function withRelayFailover<T>(
  cfg: MirrorConfig,
  action: (relay: MirrorRelay) => Promise<T>,
  context: { userId?: number | null; direction?: MirrorLogDirection; event: string },
): Promise<T> {
  const first = await resolveRelay(cfg);
  if (!first.relay) {
    throw new Error(`MIRROR_RELAY_DEGRADED: ${context.event} 无可用中继`);
  }
  try {
    return await action(first.relay);
  } catch (error) {
    console.error(`[mirror] ${context.event} 在 ${first.relay.kind} 路径失败:`, error);
    await logMirrorEvent({
      userId: context.userId ?? null,
      direction: context.direction ?? "error",
      event: "failover",
      payload: { from: first.relay.kind, reason: String(error), action: context.event },
    });
  }
  // 备选路径
  const second = await resolveHolder(first.cfg);
  const current = holders().get(first.cfg.targetBot);
  if (current) {
    Object.assign(current, second, { resolving: null, failoverAt: Date.now() });
  }
  if (!second.active) {
    throw new Error(`MIRROR_RELAY_DEGRADED: ${context.event} 备选中继亦不可用`);
  }
  const now = Date.now();
  if (now - second.lastAlertAt > ALERT_WINDOW_MS) {
    second.lastAlertAt = now;
    console.error(
      `[mirror] 已切换中继路径 ${first.status} → ${second.activeKind}（target=@${first.cfg.targetBot}）`,
    );
    await logMirrorEvent({
      userId: context.userId ?? null,
      direction: "failover",
      event: "relay_switched",
      payload: { from: first.status, to: second.activeKind },
    });
  }
  return action(second.active);
}

// ============ 恢复探测（tasks.ts 清理循环调用，5 分钟一次） ============

const RECOVERY_THRESHOLD = 3;

/**
 * 对所有 holder 做 health 探测：
 * - degraded/备选路径 连续 3 次健康 → 重新按优先级解析切回
 * - 活跃路径失活 → 置空（下次 resolveRelay 自动重新决策或降级）
 */
export async function probeRelayRecovery(): Promise<void> {
  const map = holders();
  for (const [key, current] of map) {
    if (current.active) {
      const ok = await current.active.health().catch((error: unknown) => {
        console.error(`[mirror] 活跃中继健康探测异常（target=@${key}）:`, error);
        return false;
      });
      if (!ok) {
        console.warn(`[mirror] 活跃中继失活，置空等待重新解析（target=@${key}, kind=${current.activeKind}）`);
        current.active = null;
        current.activeKind = "degraded";
        current.recoverySuccesses = 0;
        await logMirrorEvent({ direction: "failover", event: "relay_lost", payload: { targetBot: key } });
      }
      continue;
    }
    // 降级态：尝试按 auto 优先级重新解析
    const reResolved = await resolveHolder(current.cfg);
    if (reResolved.active) {
      console.warn(`[mirror] 中继恢复，重新上线（target=@${key}, kind=${reResolved.active.kind}）`);
      Object.assign(current, reResolved, { resolving: null });
      current.recoverySuccesses = RECOVERY_THRESHOLD;
      await logMirrorEvent({ direction: "failover", event: "relay_recovered", payload: { targetBot: key } });
    }
  }
  // inprocess 注册表失活检查（session 失效时中继面会自停，这里同步状态）
  if (globalForRelay.tguardMirrorRelay) {
    const ok = await globalForRelay.tguardMirrorRelay.health().catch(() => false);
    if (!ok) {
      unregisterInprocessRelay("health 探测失败");
    }
  }
}

export function relayStatusSnapshot(): {
  targetBot: string;
  status: RelayStatus;
  failoverAt: number | null;
}[] {
  return Array.from(holders().entries()).map(([targetBot, holderValue]) => ({
    targetBot,
    status: holderValue.active ? holderValue.activeKind : "degraded",
    failoverAt: holderValue.failoverAt,
  }));
}
