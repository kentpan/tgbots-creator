"use client";

import { useRef, useState } from "react";
import { ChevronDown, CloudUpload, HardDriveUpload, Loader2, Upload } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * 媒体上传按钮（与 APP 体验一致：点上传 → 选文件 → 回填 URL）。
 * 点击后弹出下拉浮层：原生上传（服务器本机存储）/ 上传到R2（Cloudflare R2）。
 */
export function MediaUploadButton({
  kind,
  storageKind,
  onUploaded,
}: {
  kind: "photo" | "video";
  storageKind: "cloudflare-r2" | "local";
  onUploaded: (url: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const modeRef = useRef<"native" | "r2">("native");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  const accept = kind === "photo" ? "image/*" : "video/*";
  const hint = kind === "photo" ? "图片" : "视频";

  const startPick = (mode: "native" | "r2"): void => {
    if (uploading) return;
    setError("");
    modeRef.current = mode;
    inputRef.current?.click();
  };

  const upload = async (file: File): Promise<void> => {
    setUploading(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("mode", modeRef.current);
      const response = await fetch("/api/admin/upload", { method: "POST", body: form });
      const payload = (await response.json().catch(() => null)) as
        | { ok: boolean; url?: string; error?: string }
        | null;
      if (!response.ok || !payload?.ok || !payload.url) {
        setError(payload?.error ?? `上传失败（${response.status}）`);
        return;
      }
      onUploaded(payload.url);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <span className="inline-flex flex-col">
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      <span className="inline-flex">
        <button
          type="button"
          disabled={uploading}
          onClick={() => startPick("native")}
          className="inline-flex h-10 items-center gap-1 rounded-l-md border border-input bg-background px-2.5 text-sm hover:bg-accent disabled:opacity-60"
          title={`选择本地${hint}上传到服务器`}
        >
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          上传
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={uploading}
              className="inline-flex h-10 items-center rounded-r-md border border-l-0 border-input bg-background px-1.5 text-sm hover:bg-accent disabled:opacity-60"
              title="选择上传目标"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onClick={() => startPick("native")} className="gap-2">
              <HardDriveUpload className="h-4 w-4" />
              <span className="flex flex-col">
                <span>原生上传</span>
                <span className="text-xs text-muted-foreground">存到服务器本机存储</span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => startPick("r2")}
              disabled={storageKind !== "cloudflare-r2"}
              className="gap-2"
            >
              <CloudUpload className="h-4 w-4" />
              <span className="flex flex-col">
                <span>上传到R2</span>
                <span className="text-xs text-muted-foreground">
                  {storageKind === "cloudflare-r2" ? "存到 Cloudflare R2" : "未检测到 R2 绑定"}
                </span>
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
      {error ? <span className="mt-1 max-w-64 text-xs text-red-600">{error}</span> : null}
    </span>
  );
}
