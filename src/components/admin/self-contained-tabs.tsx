"use client";

import { useEffect, useId, useState, type ReactNode } from "react";

/**
 * SelfContainedTabs — 统一的自包含 Tab 切换组件。
 *
 * 自包含约定：
 * - 内部自持状态（非受控）或受控（activeKey + onActiveKeyChange 同时传入）
 * - 自带全部样式与无障碍语义（role=tablist/tab/tabpanel + aria）
 * - 零外部依赖（不依赖全局 store / context），可在任意页面直接嵌入
 * - 懒挂载（v2.0.3）：面板内容仅在首次激活后才渲染（激活过的保持挂载，
 *   保留表单输入状态）。未激活的面板不渲染 content —— tab 面板里的数据
 *   加载（fetch/useEffect）只在用户真正切到该 tab 时才发起，页面首屏
 *   不再为未访问的面板发多余请求（如 AI 统计 tab 的图表数据）。
 *
 * 用途：轮询/Webhook 全局与单项配置、隐私模式全局与单项配置、
 * 从零创建机器人的分步引导（步骤即 Tab，支持外部受控翻步）。
 */

export interface SelfContainedTabItem {
  key: string;
  label: ReactNode;
  /** Tab 内容（懒渲染：仅在激活过之后挂载，保持已填表单状态） */
  content: ReactNode;
}

interface SelfContainedTabsProps {
  items: SelfContainedTabItem[];
  /** 非受控：初始激活 key（默认第一个） */
  initialKey?: string;
  /** 受控：激活 key（与 onActiveKeyChange 成对使用，例如引导的「下一步」） */
  activeKey?: string;
  onActiveKeyChange?: (key: string) => void;
  /** 激活下划线颜色类（默认 primary） */
  accentClass?: string;
  className?: string;
  ariaLabel?: string;
}

export function SelfContainedTabs({
  items,
  initialKey,
  activeKey,
  onActiveKeyChange,
  accentClass = "bg-primary",
  className = "",
  ariaLabel,
}: SelfContainedTabsProps) {
  const baseId = useId();
  const [internalKey, setInternalKey] = useState<string>(
    () => initialKey ?? items[0]?.key ?? "",
  );
  const isControlled = activeKey !== undefined && onActiveKeyChange !== undefined;
  const currentKey = isControlled ? (activeKey as string) : internalKey;
  const current = items.find((item) => item.key === currentKey) ?? items[0];

  // 懒挂载：记录已激活过的面板 key。当前 key 在渲染时乐观纳入（切换即渲染，
  // 面板内的数据请求立刻发起），随后在 effect 中固化，避免受控模式下
  // 外部翻步（引导「下一步」）永远不触发面板挂载
  const [mountedKeys, setMountedKeys] = useState<string[]>(() => [currentKey]);
  useEffect(() => {
    setMountedKeys((prev) => (prev.includes(currentKey) ? prev : [...prev, currentKey]));
  }, [currentKey]);

  const select = (key: string): void => {
    if (isControlled) onActiveKeyChange(key);
    else setInternalKey(key);
  };

  return (
    <div className={className}>
      <div
        role="tablist"
        aria-label={ariaLabel}
        className="flex flex-wrap items-center gap-1 rounded-lg border bg-muted/40 p-1"
      >
        {items.map((item) => {
          const active = item.key === current?.key;
          return (
            <button
              key={item.key}
              type="button"
              role="tab"
              id={`${baseId}-tab-${item.key}`}
              aria-selected={active}
              aria-controls={`${baseId}-panel-${item.key}`}
              tabIndex={active ? 0 : -1}
              onClick={() => select(item.key)}
              onKeyDown={(event) => {
                const index = items.findIndex((entry) => entry.key === current?.key);
                if (event.key === "ArrowRight") {
                  event.preventDefault();
                  select(items[(index + 1) % items.length].key);
                } else if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  select(items[(index - 1 + items.length) % items.length].key);
                }
              }}
              className={`relative rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                active
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-background/60 hover:text-foreground"
              }`}
            >
              {item.label}
              {active ? (
                <span
                  aria-hidden
                  className={`absolute inset-x-3 -bottom-px h-0.5 rounded-full ${accentClass}`}
                />
              ) : null}
            </button>
          );
        })}
      </div>
      {items.map((item) => {
        const active = item.key === current?.key;
        // 懒挂载：未激活过的面板只渲染占位骨架（无障碍语义完整，content 不渲染），
        // 激活过的保持挂载（hidden 切换，表单状态保留）
        const mounted = mountedKeys.includes(item.key) || item.key === currentKey;
        return (
          <div
            key={item.key}
            role="tabpanel"
            id={`${baseId}-panel-${item.key}`}
            aria-labelledby={`${baseId}-tab-${item.key}`}
            hidden={!active}
            tabIndex={0}
            className="pt-4 focus:outline-none"
          >
            {mounted ? item.content : null}
          </div>
        );
      })}
    </div>
  );
}
