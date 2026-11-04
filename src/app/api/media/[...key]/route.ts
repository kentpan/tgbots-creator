import { NextResponse } from "next/server";
import { getStorage } from "@/database/bindings";

/** 扩展名 → Content-Type（上传端已限制为图片/视频） */
const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
};

/**
 * 公开媒体读取路由：`GET /api/media/<key>`
 * 原生存储与 R2 存储统一经此提供 Telegram 服务器可访问的 http(s) URL。
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string[] }> },
): Promise<NextResponse | Response> {
  const { key: segments } = await params;
  if (!Array.isArray(segments) || segments.length === 0) {
    return NextResponse.json({ ok: false, error: "缺少文件路径" }, { status: 400 });
  }
  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\")) {
      return NextResponse.json({ ok: false, error: "非法文件路径" }, { status: 400 });
    }
  }
  const key = segments.join("/");

  const storage = getStorage();
  let data: Uint8Array | null = null;
  try {
    data = await storage.get(key);
  } catch (error) {
    console.error("Media read failed:", error);
    return NextResponse.json({ ok: false, error: "读取文件失败" }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ ok: false, error: "文件不存在" }, { status: 404 });
  }

  const ext = (key.split(".").pop() ?? "").toLowerCase();
  const contentType = CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream";
  return new Response(data as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(data.byteLength),
      "Cache-Control": "public, max-age=31536000, immutable",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
