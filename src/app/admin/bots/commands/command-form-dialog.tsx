"use client";

import { useState } from "react";
import { FormDialog } from "@/components/admin/form-dialog";
import { inputClass, labelClass } from "@/components/admin/form-styles";
import { Switch } from "@/components/ui/switch";
import { saveBotCommandAction } from "./actions";

export interface CommandFormValues {
  id: string;
  type: "builtin" | "custom";
  name: string;
  description: string;
  intro: string;
  enabled: boolean;
  sortOrder: number;
}

/**
 * 指令新建/编辑弹窗。
 * enabled 使用 Switch 开关（提交时以 hidden input 传递 1/0）。
 */
export function CommandFormDialog({
  command,
  type,
  trigger,
  triggerClassName,
}: {
  command?: CommandFormValues;
  type: "builtin" | "custom";
  trigger: React.ReactNode;
  triggerClassName?: string;
}) {
  const isEdit = Boolean(command);
  const [enabled, setEnabled] = useState(command?.enabled ?? true);

  return (
    <FormDialog
      trigger={trigger}
      triggerClassName={triggerClassName}
      title={isEdit ? (type === "builtin" ? "编辑内置指令" : "编辑自定义指令") : type === "builtin" ? "新增内置指令" : "新增自定义指令"}
      description={
        type === "builtin"
          ? "内置指令为机器人官方指令，编辑后将在机器人指令菜单同步时生效。"
          : "自定义指令保存后可在机器人「指令菜单」弹窗中勾选应用，机器人会真实注册并响应。"
      }
      action={saveBotCommandAction}
    >
      {isEdit ? <input type="hidden" name="id" value={command?.id} /> : null}
      <input type="hidden" name="type" value={type} />
      <input type="hidden" name="enabled" value={enabled ? "1" : "0"} />

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1">
          <label className={labelClass} htmlFor={`cmd-name-${command?.id ?? "new"}`}>
            指令名（1-32 位小写字母/数字/下划线）
          </label>
          <input
            id={`cmd-name-${command?.id ?? "new"}`}
            name="name"
            className={inputClass}
            defaultValue={command?.name ?? ""}
            placeholder={type === "builtin" ? "start" : "my_command"}
            pattern="[a-z0-9_]{1,32}"
            readOnly={isEdit && type === "builtin"}
            required
          />
        </div>
        <div className="space-y-1">
          <label className={labelClass} htmlFor={`cmd-sort-${command?.id ?? "new"}`}>
            排序值（越小越靠前）
          </label>
          <input
            id={`cmd-sort-${command?.id ?? "new"}`}
            name="sortOrder"
            type="number"
            className={inputClass}
            defaultValue={command?.sortOrder ?? 0}
          />
        </div>
      </div>

      <div className="space-y-1">
        <label className={labelClass} htmlFor={`cmd-desc-${command?.id ?? "new"}`}>
          指令描述（1-256 字符，显示在 Telegram 指令菜单中）
        </label>
        <input
          id={`cmd-desc-${command?.id ?? "new"}`}
          name="description"
          className={inputClass}
          defaultValue={command?.description ?? ""}
          placeholder="启动机器人"
          maxLength={256}
          required
        />
      </div>

      <div className="space-y-1">
        <label className={labelClass} htmlFor={`cmd-intro-${command?.id ?? "new"}`}>
          {type === "builtin" ? "中文介绍" : "详细介绍（用户调用指令时机器人回复的内容）"}
        </label>
        <textarea
          id={`cmd-intro-${command?.id ?? "new"}`}
          name="intro"
          className={`${inputClass} min-h-24`}
          defaultValue={command?.intro ?? ""}
          placeholder={
            type === "builtin"
              ? "官方标准入口指令，用户首次对话时自动触发……"
              : "例如：输入 /price 查询当前价格表，数据每日更新……"
          }
        />
        <p className="text-xs text-muted-foreground">
          {type === "builtin"
            ? "内置指令的中文介绍用于后台展示与文档说明，帮助管理员理解指令用途。"
            : "自定义指令没有代码逻辑，机器人被调用时会回复这段详细介绍文本。"}
        </p>
      </div>

      <div className="flex items-center justify-between rounded-md border px-4 py-3">
        <div>
          <p className="text-sm font-medium">启用指令</p>
          <p className="text-xs text-muted-foreground">
            停用的指令不会同步到 Telegram 指令菜单，也不会被机器人响应。
          </p>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="启用指令" />
      </div>
    </FormDialog>
  );
}
