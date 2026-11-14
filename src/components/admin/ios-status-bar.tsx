"use client";

import { useEffect, useState } from "react";

/** Lightweight iOS status-bar chrome shared by the mobile simulator's list and chat screens. */
export function IosStatusBar({ className = "" }: { className?: string }) {
  const [time, setTime] = useState("9:41");

  useEffect(() => {
    const update = (): void => {
      const now = new Date();
      setTime(`${now.getHours() % 12 || 12}:${String(now.getMinutes()).padStart(2, "0")}`);
    };
    update();
    const timer = window.setInterval(update, 15_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div
      aria-label="iOS 状态栏"
      className={`flex h-8 shrink-0 items-center justify-between px-6 text-[13px] font-semibold tracking-[0.01em] text-black ${className}`}
    >
      <div className="flex items-center gap-1.5">
        <span>{time}</span>
        <span aria-hidden="true" className="text-[12px]">◐</span>
      </div>
      <div className="flex items-center gap-1.5" aria-hidden="true">
        <span className="inline-flex h-3 items-end gap-[2px]">
          <i className="h-[4px] w-[3px] rounded-[1px] bg-black" />
          <i className="h-[6px] w-[3px] rounded-[1px] bg-black" />
          <i className="h-[9px] w-[3px] rounded-[1px] bg-black" />
          <i className="h-3 w-[3px] rounded-[1px] bg-black" />
        </span>
        <span className="text-[15px] leading-none">◔</span>
        <span className="rounded-[4px] border border-black px-1 py-[1px] text-[10px] leading-none">76</span>
      </div>
    </div>
  );
}
