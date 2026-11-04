"use client";

import { useState } from "react";
import { Switch } from "@/components/ui/switch";

/**
 * 表单内使用的开关字段（通用组件）：
 * 渲染 Switch 开关，同时以 hidden input 提交 1/0，供 Server Action 读取。
 * 用于「隐私模式」等布尔配置项。
 */
export function SwitchField({
  name,
  label,
  description,
  defaultChecked = true,
  id,
}: {
  name: string;
  label: string;
  description?: string;
  defaultChecked?: boolean;
  id?: string;
}) {
  const [checked, setChecked] = useState(defaultChecked);
  const inputId = id ?? `switch-field-${name}`;
  return (
    <div className="flex items-center justify-between rounded-md border px-4 py-3">
      <input type="hidden" name={name} value={checked ? "1" : "0"} />
      <div className="min-w-0 pr-3">
        <label htmlFor={inputId} className="text-sm font-medium">
          {label}
        </label>
        {description ? (
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <Switch checked={checked} onCheckedChange={setChecked} aria-label={label} />
    </div>
  );
}
