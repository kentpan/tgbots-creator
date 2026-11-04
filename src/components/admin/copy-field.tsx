"use client";

import { useState } from "react";

export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const input = document.createElement("textarea");
      input.value = value;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-1">
      <p className="text-sm font-medium text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2">
        <input
          type="text"
          readOnly
          value={value}
          className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-sm"
        />
        <button
          type="button"
          onClick={copy}
          className="inline-flex h-10 shrink-0 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent"
        >
          {copied ? "已复制" : "复制"}
        </button>
      </div>
    </div>
  );
}
