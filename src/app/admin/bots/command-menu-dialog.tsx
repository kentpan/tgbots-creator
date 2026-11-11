"use client";

import { useState } from "react";
import { Check, ChevronsUpDown, FolderTree } from "lucide-react";
import { FormDialog } from "@/components/admin/form-dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { saveBotCommandMenuAction } from "./actions";

export interface CommandLibraryItem {
  id: string;
  name: string;
  description: string;
  intro: string;
  type: "builtin" | "custom";
  /** 指令归属标注（v2.1.13）：🤖 机器人私有 / 👥 群组私有；全局/内置指令无标注 */
  scopeLabel?: string;
}

/**
 * 「指令菜单」配置模块（v2.2.8 从 CommandMenuDialog 抽出，供两处复用）：
 * - 隐私模式 Switch（写入 bots.config.privacyMode，bot 运行时真实生效）
 * - 指令选择浮层：内置指令 / 自定义指令 两个页签，多选指令库中的指令
 * 状态受控（privacyMode/selected/onToggle 由宿主持有）：
 * - 机器人管理页「指令菜单」弹窗：宿主 CommandMenuDialog，随独立表单提交
 * - TGAPI申请页「菜单和键盘」统一弹窗：宿主 bot-designer-dialog，作为指令菜单
 *   配置模块渲染在「界面模式」上方，随统一表单 hidden 字段提交
 */
export function CommandMenuConfigFields({
  privacyMode,
  onPrivacyModeChange,
  selected,
  onToggle,
  library,
}: {
  privacyMode: boolean;
  onPrivacyModeChange: (value: boolean) => void;
  selected: number[];
  onToggle: (id: number) => void;
  library: CommandLibraryItem[];
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [tab, setTab] = useState<"builtin" | "custom">("builtin");

  const selectedItems = library.filter((item) => selected.includes(Number(item.id)));
  const pickerLabel = selectedItems.length
    ? selectedItems
        .slice(0, 3)
        .map((item) => `/${item.name}`)
        .join("、") + (selectedItems.length > 3 ? ` 等 ${selectedItems.length} 条` : "")
    : "点击选择指令（可多选）";

  return (
    <>
      {/* 隐私模式开关（通用功能，真实生效） */}
      <div className="flex items-center justify-between rounded-md border px-4 py-3">
        <div>
          <p className="text-sm font-medium">隐私模式（Privacy Mode）</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            开启：指令仅匹配消息开头的标准 <code className="rounded bg-muted px-1">/指令</code>
            （Telegram 隐私模式下机器人唯一能收到的指令形式），加群验证同样以
            stateless-question 回复式完成，无需关闭隐私模式。
            关闭：指令支持消息任意位置与 <code className="rounded bg-muted px-1">/指令@机器人</code>{" "}
            定向写法（要求已在 BotFather 关闭隐私模式）。
          </p>
        </div>
        <Switch checked={privacyMode} onCheckedChange={onPrivacyModeChange} aria-label="隐私模式" />
      </div>

      {/* 指令选择浮层（双 Tab 多选） */}
      <div className="space-y-1">
        <label className="text-sm font-medium">指令菜单内容（来自指令库）</label>
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none transition focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
            >
              <span className="flex min-w-0 items-center gap-1.5 truncate">
                <FolderTree className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{pickerLabel}</span>
              </span>
              <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-[420px] p-0" align="start">
            <div className="flex gap-1 border-b p-1">
              {(
                [
                  { key: "builtin", label: "内置指令" },
                  { key: "custom", label: "自定义指令" },
                ] as const
              ).map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setTab(item.key)}
                  className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    tab === item.key
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="max-h-72 overflow-y-auto overflow-x-hidden">
              {library.filter((item) => item.type === tab).length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                  {tab === "builtin"
                    ? "内置指令库为空"
                    : "还没有自定义指令，前往「机器人 → 指令管理 → 自定义指令」创建"}
                </p>
              ) : (
                library
                  .filter((item) => item.type === tab)
                  .map((item) => {
                    const checked = selected.includes(Number(item.id));
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => onToggle(Number(item.id))}
                        className={`flex w-full items-start gap-2 border-b px-3 py-2 text-left text-sm last:border-0 ${
                          checked ? "bg-primary/5" : "hover:bg-accent"
                        }`}
                      >
                        <span
                          className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                            checked ? "border-primary bg-primary text-primary-foreground" : "border-input"
                          }`}
                        >
                          {checked ? <Check className="h-3 w-3" /> : null}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <code className="rounded bg-muted px-1 text-xs">/{item.name}</code>
                            {item.scopeLabel ? (
                              <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                                {item.scopeLabel}
                              </span>
                            ) : null}
                            <span className="truncate text-xs text-muted-foreground">
                              {item.description}
                            </span>
                          </span>
                          {item.intro ? (
                            <span className="mt-1 line-clamp-2 block text-xs text-muted-foreground/80">
                              {item.intro}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    );
                  })
              )}
            </div>
            <p className="border-t px-3 py-1.5 text-xs text-muted-foreground">
              已选 {selected.length} 条指令；停用的指令不会同步到 Telegram。
            </p>
          </PopoverContent>
        </Popover>
      </div>

      {selectedItems.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {selectedItems.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onToggle(Number(item.id))}
              className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2.5 py-1 text-xs hover:bg-accent"
              title="点击移除"
            >
              <code>/{item.name}</code>
              <span className="text-muted-foreground">✕</span>
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

/**
 * 机器人「指令菜单」配置弹窗：
 * - 隐私模式 Switch（写入 bots.config.privacyMode，bot 运行时真实生效）
 * - 指令选择浮层：内置指令 / 自定义指令 两个页签，多选指令库中的指令
 * 保存后服务端调用 setMyCommands 同步 Telegram 指令菜单并热更新运行实例。
 */
export function CommandMenuDialog({
  bot,
  library,
  trigger,
  triggerClassName,
}: {
  bot: {
    id: string;
    name: string;
    privacyMode: boolean;
    selectedCommandIds: number[];
  };
  library: CommandLibraryItem[];
  trigger: React.ReactNode;
  triggerClassName?: string;
}) {
  const [privacyMode, setPrivacyMode] = useState(bot.privacyMode);
  const [selected, setSelected] = useState<number[]>(bot.selectedCommandIds);

  const toggle = (id: number) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  };

  return (
    <FormDialog
      trigger={trigger}
      triggerClassName={triggerClassName}
      title={`指令菜单 · ${bot.name}`}
      description="指令注册的唯一来源：勾选要应用到该机器人的指令，保存后立即注册响应（按钮点击与手输 /指令 同源）并同步到 Telegram 指令菜单；未勾选的指令不注册、不响应。"
      action={saveBotCommandMenuAction}
      contentClassName="sm:max-w-2xl"
    >
      <input type="hidden" name="id" value={bot.id} />
      <input type="hidden" name="privacyMode" value={privacyMode ? "1" : "0"} />
      <input type="hidden" name="commandIds" value={JSON.stringify(selected)} />

      <CommandMenuConfigFields
        privacyMode={privacyMode}
        onPrivacyModeChange={setPrivacyMode}
        selected={selected}
        onToggle={toggle}
        library={library}
      />
    </FormDialog>
  );
}
