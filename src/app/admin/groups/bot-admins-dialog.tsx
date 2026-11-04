"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { removeBotGroupAdminAction, setBotGroupAdminAction } from "../bots/actions";

const RIGHTS: { key: string; label: string }[] = [
  { key: "can_manage_chat", label: "管理聊天（默认管理员权限）" },
  { key: "can_change_info", label: "修改群组信息" },
  { key: "can_delete_messages", label: "删除消息" },
  { key: "can_invite_users", label: "邀请用户" },
  { key: "can_restrict_members", label: "封禁/限制成员" },
  { key: "can_pin_messages", label: "置顶消息" },
  { key: "can_manage_video_chats", label: "管理视频会议" },
  { key: "can_promote_members", label: "添加新管理员" },
];

export interface GroupBotAdminEntry {
  id: string;
  botName: string;
  botUsername: string | null;
  rights: Record<string, boolean>;
}

export function BotAdminsDialog({
  chatId,
  bots,
  admins,
  trigger,
  triggerClassName,
}: {
  chatId: string;
  bots: { id: string; name: string; username: string | null }[];
  admins: GroupBotAdminEntry[];
  trigger: React.ReactNode;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" className={triggerClassName}>
          {trigger}
        </button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[88vh] flex-col overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <DialogTitle>群组机器人管理员</DialogTitle>
          <DialogDescription>
            把已接入的机器人提升为本群管理员并精确配置权限；移除时自动撤销其管理员身份。
          </DialogDescription>
        </DialogHeader>
        <form
          action={setBotGroupAdminAction}
          className="flex min-h-0 flex-1 flex-col"
        >
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden px-6 py-4">
          {admins.length === 0 ? (
            <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
              本群还没有机器人管理员，使用下方表单添加
            </p>
          ) : (
            <div className="space-y-2">
              {admins.map((admin) => (
                <div key={admin.id} className="rounded-lg border p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">
                      {admin.botName}
                      {admin.botUsername ? (
                        <span className="text-muted-foreground">（@{admin.botUsername}）</span>
                      ) : null}
                    </p>
                    <form action={removeBotGroupAdminAction}>
                      <input type="hidden" name="id" value={admin.id} />
                      <button
                        type="submit"
                        className="rounded border border-red-200 px-2 py-1 text-sm text-red-600 hover:bg-red-50"
                      >
                        移除
                      </button>
                    </form>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {RIGHTS.filter((right) => admin.rights[right.key])
                      .map((right) => right.label)
                      .join("、") || "未授予具体权限"}
                  </p>
                </div>
              ))}
            </div>
          )}

          {bots.length === 0 ? (
            <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              还没有可用的机器人，请先到「机器人 → 机器人管理」接入。
            </p>
          ) : (
            <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
              <p className="text-sm font-medium">添加 / 更新机器人管理员</p>
              <input type="hidden" name="chat_id" value={chatId} />
              <div className="space-y-1">
                <label className="block text-sm font-medium" htmlFor={`bot-select-${chatId}`}>
                  选择机器人
                </label>
                <select id={`bot-select-${chatId}`} name="bot_id" required className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                  {bots.map((bot) => (
                    <option key={bot.id} value={bot.id}>
                      {bot.name}
                      {bot.username ? `（@${bot.username}）` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {RIGHTS.map((right) => (
                  <label key={right.key} className="flex items-center gap-2 rounded-md p-2 text-sm hover:bg-accent">
                    <input type="checkbox" name={right.key} value="1" className="h-4 w-4" />
                    <span>{right.label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t bg-muted/30 px-6 py-3">
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="inline-flex h-10 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent"
          >
            关闭
          </button>
          <button
            type="submit"
            disabled={bots.length === 0}
            className="inline-flex h-10 items-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            提升为管理员并保存权限
          </button>
        </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
