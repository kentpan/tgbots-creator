export interface MirrorConfig {
  targetBot: string;
  relayMode?: "auto" | "inprocess" | "remote";
  relayBaseUrl?: string;
  /** 绑定开发者账号（developer_accounts 表）：中继面 userbot 的 api_id/api_hash 来源 */
  developerAccountId?: number;
  allowedUserIds?: number[];
  /** 访问模式：open=所有人可用；verify_bot=须先通过绑定的加群验证机器人验证；whitelist=仅白名单 */
  accessMode?: "open" | "verify_bot" | "whitelist";
  /** verify_bot 模式绑定的加群验证机器人（bots 表 id） */
  verifyBotId?: number;
  serializeMode?: "global" | "per_user";
  actionTimeoutSeconds?: number;
  syncCommands?: boolean;
  mediaInlineMaxMb?: number;
  rewriteRules?: Record<string, string>;
}

export interface ResolvedMirrorConfig {
  targetBot: string;
  relayMode: "auto" | "inprocess" | "remote";
  relayBaseUrl: string;
  developerAccountId: number | null;
  allowedUserIds: number[];
  accessMode: "open" | "verify_bot" | "whitelist";
  verifyBotId: number | null;
  serializeMode: "global" | "per_user";
  actionTimeoutSeconds: number;
  syncCommands: boolean;
  mediaInlineMaxMb: number;
  rewriteRules: Record<string, string>;
}

export const MIRROR_DEFAULTS: Omit<MirrorConfig, "targetBot"> = {
  relayMode: "auto",
  relayBaseUrl: "",
  allowedUserIds: [],
  serializeMode: "global",
  actionTimeoutSeconds: 60,
  syncCommands: true,
  mediaInlineMaxMb: 20,
  rewriteRules: {},
};

/** bots.config JSON 中的 mirror 段解析；缺失/非法返回 null（非镜像 bot） */
export function parseMirrorConfig(raw: string): MirrorConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const mirror = (parsed as Record<string, unknown>).mirror;
  if (typeof mirror !== "object" || mirror === null) return null;
  const targetBot = String((mirror as Record<string, unknown>).targetBot ?? "").trim();
  if (!targetBot) return null;
  return mirror as MirrorConfig;
}

export function resolveMirrorConfig(cfg: MirrorConfig): ResolvedMirrorConfig {
  const mode = cfg.relayMode;
  const accessMode =
    cfg.accessMode === "verify_bot" || cfg.accessMode === "whitelist" ? cfg.accessMode : "open";
  return {
    targetBot: cfg.targetBot.replace(/^@/, "").trim(),
    relayMode: mode === "inprocess" || mode === "remote" ? mode : "auto",
    relayBaseUrl: (cfg.relayBaseUrl ?? MIRROR_DEFAULTS.relayBaseUrl!).trim().replace(/\/+$/, ""),
    developerAccountId:
      Number.isInteger(cfg.developerAccountId) && Number(cfg.developerAccountId) > 0
        ? Number(cfg.developerAccountId)
        : null,
    allowedUserIds: Array.isArray(cfg.allowedUserIds) ? cfg.allowedUserIds.map(Number) : [],
    accessMode,
    verifyBotId:
      accessMode === "verify_bot" && Number.isInteger(cfg.verifyBotId) && Number(cfg.verifyBotId) > 0
        ? Number(cfg.verifyBotId)
        : null,
    serializeMode: cfg.serializeMode === "per_user" ? "per_user" : "global",
    actionTimeoutSeconds: Math.min(300, Math.max(5, cfg.actionTimeoutSeconds ?? 60)),
    syncCommands: cfg.syncCommands !== false,
    mediaInlineMaxMb: Math.min(20, Math.max(1, cfg.mediaInlineMaxMb ?? 20)),
    rewriteRules: cfg.rewriteRules && typeof cfg.rewriteRules === "object" ? cfg.rewriteRules : {},
  };
}

/** 目标 bot 档案（probe 结果 / 命令表缓存） */
export interface TargetProfile {
  username: string;
  title: string;
  description: string;
  commands: { command: string; description: string }[];
}

/** BotCallbackAnswer 的 Bot API 侧等价物 */
export interface BotAnswer {
  alert?: boolean;
  message?: string;
  url?: string;
}

/** 上行媒体载荷（用户 → 目标 bot） */
export interface UpstreamMedia {
  kind: "photo" | "document" | "video" | "audio" | "voice" | "video_note" | "sticker" | "animation";
  bytes: Uint8Array;
  filename?: string;
  caption?: string;
  mimeType?: string;
}
