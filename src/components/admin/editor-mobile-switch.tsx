"use client";

import { Smartphone, SlidersHorizontal, Eye } from "lucide-react";

/** Mobile-only switch between the editor and its live Telegram preview. */
export function EditorMobileSwitch({
  value,
  onChange,
}: {
  value: "config" | "preview";
  onChange: (value: "config" | "preview") => void;
}) {
  return (
    <div className="sticky top-0 z-30 grid grid-cols-2 gap-1 rounded-xl border bg-background/95 p-1 shadow-sm backdrop-blur lg:hidden">
      <button
        type="button"
        aria-pressed={value === "config"}
        onClick={() => onChange("config")}
        className={`flex min-h-10 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors ${value === "config" ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-muted"}`}
      >
        <SlidersHorizontal className="h-4 w-4" /> 配置编辑
      </button>
      <button
        type="button"
        aria-pressed={value === "preview"}
        onClick={() => onChange("preview")}
        className={`flex min-h-10 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors ${value === "preview" ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-muted"}`}
      >
        <Smartphone className="h-4 w-4" /> <Eye className="h-4 w-4" /> 仿真预览
      </button>
    </div>
  );
}
