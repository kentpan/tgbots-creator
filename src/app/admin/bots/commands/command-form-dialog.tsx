"use client";

import { useState } from "react";
import { FormDialog } from "@/components/admin/form-dialog";
import { inputClass, labelClass, selectClass } from "@/components/admin/form-styles";
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
  /** 归属（v2.1.13）：机器人私有 = bots.id 字符串；null = 不限定机器人 */
  botId: string | null;
  /** 归属（v2.1.13）：群组私有 = group_settings.chat_id 字符串；null = 不限定群组 */
  groupId: string | null;
}

/** 机器人下拉选项（服务端传入全量机器人） */
export interface ScopeBotOption {
  id: string;
  name: string;
}

/** 群组下拉选项（服务端传入全量群组） */
export interface ScopeGroupOption {
  chatId: string;
  chatTitle: string | null;
}

/**
 * 指令新建/编辑弹窗。
 * enabled 使用 Switch 开关（提交时以 hidden input 传递 1/0）。
 *
 * v2.1.13 指令归属（仅自定义指令提供）：两个独立维度下拉且互斥 ——
 * 「所属机器人」与「所属群组」任一选择后另一个自动清空并禁用，
 * 机器人私有与群组私有绝不混淆；均不选 = 全局指令。
 */
export function CommandFormDialog({
  command,
  type,
  trigger,
  triggerClassName,
  bots = [],
  groups = [],
}: {
  command?: CommandFormValues;
  type: "builtin" | "custom";
  trigger: React.ReactNode;
  triggerClassName?: string;
  bots?: ScopeBotOption[];
  groups?: ScopeGroupOption[];
}) {
  const isEdit = Boolean(command);
  const [enabled, setEnabled] = useState(command?.enabled ?? true);
  // 归属互斥状态（字符串 "" = 全局）：选机器人清空群组，选群组清空机器人
  const [botId, setBotId] = useState(command?.botId ?? "");
  const [groupId, setGroupId] = useState(command?.groupId ?? "");

  const handleBotChange = (value: string): void => {
    setBotId(value);
    if (value) setGroupId("");
  };
  const handleGroupChange = (value: string): void => {
    setGroupId(value);
    if (value) setBotId("");
  };

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
      {/* 归属随表单提交（"" = 全局）；互斥由 onChange 保证，服务端再校验 */}
      <input type="hidden" name="botId" value={botId} />
      <input type="hidden" name="groupId" value={groupId} />

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

      {type === "custom" ? (
        <div className="space-y-2 rounded-md border px-4 py-3">
          <div>
            <p className="text-sm font-medium">指令归属（机器人 / 群组私有，二选一）</p>
            <p className="text-xs text-muted-foreground">
              两个维度独立且互斥：选了机器人私有就不能再选群组私有，反之亦然；都不选 = 全局指令（所有机器人可用）。
              机器人私有指令仅该机器人可注册响应；群组私有指令仅在绑定群组内真实执行。
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <label className={labelClass} htmlFor={`cmd-bot-scope-${command?.id ?? "new"}`}>
                所属机器人（机器人私有）
              </label>
              <select
                id={`cmd-bot-scope-${command?.id ?? "new"}`}
                value={botId}
                onChange={(event) => handleBotChange(event.target.value)}
                disabled={Boolean(groupId)}
                className={`${selectClass} ${groupId ? "opacity-50" : ""}`}
              >
                <option value="">🌐 全局（所有机器人可用）</option>
                {bots.map((bot) => (
                  <option key={bot.id} value={bot.id}>
                    🤖 {bot.name}（ID {bot.id}）私有
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className={labelClass} htmlFor={`cmd-group-scope-${command?.id ?? "new"}`}>
                所属群组（群组私有）
              </label>
              <select
                id={`cmd-group-scope-${command?.id ?? "new"}`}
                value={groupId}
                onChange={(event) => handleGroupChange(event.target.value)}
                disabled={Boolean(botId)}
                className={`${selectClass} ${botId ? "opacity-50" : ""}`}
              >
                <option value="">不限定群组</option>
                {groups.map((group) => (
                  <option key={group.chatId} value={group.chatId}>
                    👥 {group.chatTitle ?? "群组"}（{group.chatId}）
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {botId
              ? `当前归属：🤖 机器人私有 —— 仅「${bots.find((bot) => bot.id === botId)?.name ?? `ID ${botId}`}」的运行实例可注册并响应该指令。`
              : groupId
                ? `当前归属：👥 群组私有 —— 指令仍按机器人级注册，但仅在「${groups.find((group) => group.chatId === groupId)?.chatTitle ?? groupId}」内真实执行。`
                : "当前归属：🌐 全局 —— 在「指令菜单」弹窗勾选的任何机器人都会注册并响应。"}
          </p>
        </div>
      ) : null}

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
