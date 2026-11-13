"use client";

import { useState, type ReactNode } from "react";
import { Switch } from "@/components/ui/switch";
import { ChevronDown, ChevronRight } from "lucide-react";

/**
 * 通用可折叠功能面板（head 左侧标题+说明，右侧 Switch + 展开箭头）：
 *
 * 语义（全站统一）：
 * - Switch ON  = 该功能生效 + 面板展开；
 * - Switch OFF = 该功能不生效 + 面板收起；面板内已配置的数据永不清空，
 *   表单照常提交保存（运行时按开关决定是否生效），重开 ON 原样回显。
 * - 展开箭头允许在开关 ON 时折叠查看（OFF 时强制收起）。
 */
export function ConfigPanel({
  title,
  description,
  checked,
  onCheckedChange,
  children,
  defaultOpen = true,
}: {
  title: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const expanded = checked && open;

  return (
    <div className="rounded-lg border">
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={() => checked && setOpen((prev) => !prev)}
          aria-label={expanded ? "收起" : "展开"}
          className={`flex h-6 w-6 items-center justify-center rounded ${checked ? "text-muted-foreground hover:bg-accent" : "text-muted-foreground/40"}`}
          disabled={!checked}
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-tight">{title}</p>
          {description ? (
            <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{description}</p>
          ) : null}
        </div>
        <Switch
          checked={checked}
          onCheckedChange={onCheckedChange}
          aria-label={title}
        />
      </div>
      {expanded ? <div className="border-t px-4 py-3">{children}</div> : null}
    </div>
  );
}
