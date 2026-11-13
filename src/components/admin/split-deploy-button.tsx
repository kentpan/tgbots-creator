"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";

/**
 * 通用分体自包含部署按钮（主区 + 右侧下拉箭头，复刻 Telegram 分体按钮形态）：
 * - 直接点击主区 = 执行「全部部署」动作；
 * - 点击右侧箭头 = 弹出下拉选择浮层，选择单个目标执行单项部署；
 * - 浮层列表项左侧：已部署目标显示绿色 ✓（真实部署状态判定，绝不假标记）。
 */
export function SplitDeployButton({
  mainLabel,
  mainBusy,
  mainDisabled,
  onMain,
  items,
  itemBusyId,
  onSelectItem,
  /** 浮层打开时按需加载数据（可选；返回异步即可） */
  onLoadItems,
  emptyHint,
}: {
  mainLabel: string;
  mainBusy?: boolean;
  mainDisabled?: boolean;
  onMain: () => void;
  items: { id: string; label: string; deployed: boolean }[];
  itemBusyId?: string | null;
  onSelectItem: (id: string) => void;
  onLoadItems?: () => void | Promise<void>;
  emptyHint?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 点击浮层外部关闭
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const handleToggle = (): void => {
    const next = !open;
    setOpen(next);
    if (next) void onLoadItems?.();
  };

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        onClick={onMain}
        disabled={mainDisabled || mainBusy}
        className="flex h-[30px] flex-1 items-center justify-center gap-1.5 rounded-l-lg text-[13px] font-medium transition-colors disabled:opacity-60"
        style={{
          backgroundColor: "rgba(51, 144, 236, 0.1)",
          color: "#3390ec",
          paddingLeft: 12,
          paddingRight: 10,
        }}
        title={mainLabel}
      >
        {mainBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        {mainLabel}
      </button>
      <button
        type="button"
        onClick={handleToggle}
        aria-label="展开部署选择"
        aria-expanded={open}
        className="flex h-[30px] w-7 items-center justify-center rounded-r-lg border-l border-white/40 transition-colors hover:brightness-95"
        style={{ backgroundColor: "rgba(51, 144, 236, 0.18)", color: "#3390ec" }}
      >
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open ? (
        <div className="absolute left-0 top-[34px] z-50 w-64 overflow-hidden rounded-xl border border-black/10 bg-white shadow-lg">
          {items.length === 0 ? (
            <p className="px-3 py-2.5 text-[12px] leading-relaxed text-[#8e8e93]">
              {emptyHint ?? "暂无可选目标"}
            </p>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onSelectItem(item.id);
                  }}
                  disabled={itemBusyId === item.id}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13px] text-black transition-colors hover:bg-black/[0.04] disabled:opacity-60"
                >
                  <span className="flex w-4 shrink-0 justify-center">
                    {item.deployed ? <Check className="h-3.5 w-3.5 text-[#34c759]" /> : null}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {itemBusyId === item.id ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : null}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
