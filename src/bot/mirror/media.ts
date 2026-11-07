import type { Api, Context } from "grammy";
import { createMirrorJob, logMirrorEvent } from "./store";
import type { UpstreamMedia } from "./types";

type MediaKind = UpstreamMedia["kind"];

interface MediaCandidate {
  kind: MediaKind;
  fileId: string;
  filename?: string;
  mimeType?: string;
}

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "audio/ogg": ".oga",
  "application/pdf": ".pdf",
};

function candidateFromMessage(msg: Context["message"]): MediaCandidate | null {
  if (!msg) return null;
  if (msg.photo && msg.photo.length > 0) {
    return { kind: "photo", fileId: msg.photo[msg.photo.length - 1].file_id };
  }
  if (msg.document) {
    return {
      kind: "document",
      fileId: msg.document.file_id,
      filename: msg.document.file_name ?? undefined,
      mimeType: msg.document.mime_type ?? undefined,
    };
  }
  if (msg.video) {
    return { kind: "video", fileId: msg.video.file_id, mimeType: msg.video.mime_type ?? undefined };
  }
  if (msg.audio) {
    return {
      kind: "audio",
      fileId: msg.audio.file_id,
      filename: msg.audio.file_name ?? undefined,
      mimeType: msg.audio.mime_type ?? undefined,
    };
  }
  if (msg.voice) return { kind: "voice", fileId: msg.voice.file_id, mimeType: "audio/ogg" };
  if (msg.video_note) {
    return { kind: "video_note", fileId: msg.video_note.file_id, mimeType: "video/mp4" };
  }
  if (msg.sticker) return { kind: "sticker", fileId: msg.sticker.file_id };
  if (msg.animation) {
    return { kind: "animation", fileId: msg.animation.file_id, mimeType: "video/mp4" };
  }
  return null;
}

export function upstreamMediaFromContext(ctx: Context): {
  candidate: MediaCandidate;
  caption?: string;
} | null {
  const candidate = candidateFromMessage(ctx.message);
  if (!candidate) return null;
  const caption = ctx.message?.caption ?? undefined;
  return { candidate, caption };
}

export class MediaTooLargeError extends Error {
  constructor(public readonly sizeMb: number, public readonly limitMb: number) {
    super(`媒体 ${sizeMb.toFixed(1)}MB 超过内联上限 ${limitMb}MB`);
    this.name = "MediaTooLargeError";
  }
}

/**
 * 上行媒体收集（L1）：Bot API getFile → CDN fetch。
 * Bot API 侧 getFile 物理上限 20MB，超限文件 Telegram 不提供下载 → 直接抛
 * MediaTooLargeError，由调用方落 L2 作业占位并告知用户。
 */
export async function collectUpstreamMedia(
  api: Api,
  botToken: string,
  input: { candidate: MediaCandidate; caption?: string },
  inlineMaxMb: number,
): Promise<UpstreamMedia> {
  const file = await api.getFile(input.candidate.fileId);
  const sizeBytes = file.file_size ?? 0;
  const sizeMb = sizeBytes / (1024 * 1024);
  if (sizeMb > inlineMaxMb) {
    throw new MediaTooLargeError(sizeMb, inlineMaxMb);
  }
  if (!file.file_path) {
    throw new Error(`getFile 未返回 file_path（file_id=${input.candidate.fileId}）`);
  }
  const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`媒体下载失败 HTTP ${response.status}（url=${url}）`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const filename =
    input.candidate.filename ??
    `mirror-${Date.now()}${EXT_BY_MIME[input.candidate.mimeType ?? ""] ?? (input.candidate.kind === "photo" ? ".jpg" : "")}`;
  return {
    kind: input.candidate.kind,
    bytes,
    filename,
    caption: input.caption,
    mimeType: input.candidate.mimeType ?? "application/octet-stream",
  };
}

/** 媒体超限 → 落 L2 作业占位（状态 failed：Bot API 无法提供 >20MB 上行文件） */
export async function recordOversizeMediaJob(input: {
  userId: number;
  proxyChatId: number;
  kind: MediaKind;
}): Promise<void> {
  await createMirrorJob({
    userId: input.userId,
    proxyChatId: input.proxyChatId,
    targetMsgId: 0,
    mediaKind: input.kind,
  });
  await finishLatestJobAsFailed(input.kind);
  await logMirrorEvent({
    userId: input.userId,
    direction: "error",
    event: "media_oversize",
    payload: { kind: input.kind, note: "Bot API getFile 上限 20MB，无法镜像上行大文件" },
  });
}

async function finishLatestJobAsFailed(kind: MediaKind): Promise<void> {
  const { listMirrorJobs, finishMirrorJob } = await import("./store");
  const jobs = await listMirrorJobs("pending", 1);
  for (const job of jobs) {
    if (job.mediaKind === kind) {
      await finishMirrorJob(job.id, "failed", "上行文件超过 Bot API 20MB 下载上限");
    }
  }
}
