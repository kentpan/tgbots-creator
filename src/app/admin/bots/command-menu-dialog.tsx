"use client";

import { useState } from "react";
import { Check, ChevronsUpDown, FolderTree } from "lucide-react";
import { FormDialog } from "@/components/admin/form-dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { saveBotCommandMenuAction } from "./actions";

// v2.3 重构：配置字段移入共享层 components/admin/command-menu-fields.tsx（两弹窗共用）
import {
  CommandMenuConfigFields,
  type CommandLibraryItem,
} from "@/components/admin/command-menu-fields";
export { CommandMenuConfigFields };
export type { CommandLibraryItem };

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
