"use client";

import { useState } from "react";
import { MENU_PERMISSION_OPTIONS, MENU_PERMISSION_VIEW } from "@/lib/menu-permissions";

/**
 * 菜单权限自包含 tab 切换按钮：只提供 读取 / 编辑 两档权限，
 * 内部自管理状态并携带 hidden input 直接随表单提交。
 */
export function PermissionTabs({
  name = "permission_code",
  defaultValue = MENU_PERMISSION_VIEW,
}: {
  name?: string;
  defaultValue?: string;
}) {
  const initial = MENU_PERMISSION_OPTIONS.some((option) => option.value === defaultValue)
    ? defaultValue
    : MENU_PERMISSION_VIEW;
  const [value, setValue] = useState(initial);
  const active = MENU_PERMISSION_OPTIONS.find((option) => option.value === value);

  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium">权限要求</label>
      <input type="hidden" name={name} value={value} />
      <div className="inline-flex rounded-md border border-input bg-muted/40 p-0.5">
        {MENU_PERMISSION_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setValue(option.value)}
            className={`inline-flex h-8 items-center rounded-[5px] px-4 text-sm transition ${
              value === option.value
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{active?.hint}</p>
    </div>
  );
}
