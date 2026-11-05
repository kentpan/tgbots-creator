"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { SwitchField } from "@/components/admin/switch-field";
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
  /** bots.id：回显已保存配置用（v1.2.0） */
  botId: string;
  botName: string;
  botUsername: string | null;
  rights: Record<string, boolean>;
}

/**
 * form 内主提交按钮（v1.2.0）：
 * useFormStatus 读取所属表单的 pending 状态 —— 保存中显示旋转 loading、禁用按钮；
 * 整个弹窗只有一个 form，「关闭」按钮通过同一 pending 状态联动禁用。
 */
function SaveSubmitButton({ disabled }: { disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
      {pending ? "保存中…" : "提升为管理员并保存权限"}
    </button>
  );
}

/** 「移除」提交按钮（v1.2.0）：不再是嵌套 form，改为 formAction 指向 bind 预绑定参数的移除 action；
 * 保存中同样显示 loading 并禁用 */
function RemoveAdminButton({ adminId }: { adminId: string }) {
  const { pending } = useFormStatus();
  const removeAction = removeBotGroupAdminAction.bind(null, adminId);
  return (
    <button
      type="submit"
      formAction={removeAction}
      disabled={pending}
      className="inline-flex items-center gap-1 rounded border border-red-200 px-2 py-1 text-sm text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
      移除
    </button>
  );
}

/** 「关闭」按钮（v1.2.0）：保存/移除请求进行中（pending）时禁用，防止中途关闭打断重定向 */
function CloseDialogButton({ onClose }: { onClose: () => void }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="button"
      onClick={onClose}
      disabled={pending}
      className="inline-flex h-10 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
    >
      关闭
    </button>
  );
}

export function BotAdminsDialog({
  chatId,
  bots,
  admins,
  requireApproval = false,
  trigger,
  triggerClassName,
}: {
  chatId: string;
  bots: { id: string; name: string; username: string | null }[];
  admins: GroupBotAdminEntry[];
  /** 当前「加群需要管理员审核」状态（group_settings.require_approval） */
  requireApproval?: boolean;
  trigger: React.ReactNode;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  /** 当前选中 bot（受控，v1.2.0）：打开弹窗/切换选项时回显该 bot 已保存的管理员权限 */
  const [selectedBotId, setSelectedBotId] = useState("");
  /** 编辑区重建键：每次打开弹窗强制按最新 admins 数据重建默认勾选（避免残留旧状态） */
  const [editorResetKey, setEditorResetKey] = useState(0);

  /** 初始选中：第一个已在弹窗下拉列表中的已保存管理员；无则选第一个可用 bot */
  const resolveInitialBotId = (): string => {
    for (const admin of admins) {
      if (bots.some((bot) => bot.id === admin.botId)) return admin.botId;
    }
    return bots[0]?.id ?? "";
  };

  const handleOpenChange = (next: boolean): void => {
    setOpen(next);
    if (next) {
      setSelectedBotId(resolveInitialBotId());
      setEditorResetKey((key) => key + 1);
    }
  };

  /** 选中的 bot 是否已有已保存的管理员配置（有 → 回显其权限勾选） */
  const selectedAdmin = admins.find((admin) => admin.botId === selectedBotId) ?? null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
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
        {/* 整个弹窗唯一 form（v1.2.0）：滚动区与底部按钮区都在 form 内，
            「移除」用 formAction 切换 action，彻底消除 form 嵌套导致的 hydration 报错 */}
        <form action={setBotGroupAdminAction} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden px-6 py-4">
            {/* 已有管理员列表 */}
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
                      <RemoveAdminButton adminId={admin.id} />
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
              <div
                key={`bot-editor-${chatId}-${selectedBotId}-${editorResetKey}`}
                className="space-y-3 rounded-lg border bg-muted/30 p-3"
              >
                <p className="text-sm font-medium">添加 / 更新机器人管理员</p>
                <input type="hidden" name="chat_id" value={chatId} />
                <div className="space-y-1">
                  <label className="block text-sm font-medium" htmlFor={`bot-select-${chatId}`}>
                    选择机器人
                  </label>
                  <select
                    id={`bot-select-${chatId}`}
                    name="bot_id"
                    required
                    value={selectedBotId}
                    onChange={(event) => setSelectedBotId(event.target.value)}
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {bots.map((bot) => (
                      <option key={bot.id} value={bot.id}>
                        {bot.name}
                        {bot.username ? `（@${bot.username}）` : ""}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">
                    {selectedAdmin
                      ? "已回显该机器人上次保存的权限勾选；再次保存时以 Telegram 实际权限为准同步。"
                      : "该机器人尚未配置为管理员：保存时自动尝试通过其它管理员机器人提升，或保存配置并给出手动指引。"}
                  </p>
                </div>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  {RIGHTS.map((right) => (
                    <label key={right.key} className="flex items-center gap-2 rounded-md p-2 text-sm hover:bg-accent">
                      <input
                        type="checkbox"
                        name={right.key}
                        value="1"
                        defaultChecked={selectedAdmin?.rights?.[right.key] === true}
                        className="h-4 w-4"
                      />
                      <span>{right.label}</span>
                    </label>
                  ))}
                </div>
                <div className="space-y-2 border-t pt-3">
                  <p className="text-sm font-medium">加群审核</p>
                  <SwitchField
                    name="require_approval"
                    label="加群需要管理员审核（审批新成员）"
                    description="与 Telegram APP 群组设置中的「审批新成员」对应：开启后用户入群需先提交申请，由机器人完成验证审批。注意：Telegram Bot API 官方限制无法远程修改该全局开关，需在 TG 客户端群设置→权限→审批新成员 同步开启；本系统生成的入群申请链接始终强制需审批，普通链接直接入群的用户也会被私聊补验证（超时/失败自动移出）。"
                    defaultChecked={requireApproval}
                    id={`require-approval-${chatId}`}
                  />
                  <p className="text-xs text-muted-foreground">
                    保存时会尝试真实同步：机器人已是管理员 → 读取并保存 Telegram 实际权限；尚未是管理员 → 自动尝试通过其它管理员机器人提升；均不可用时给出手动操作指引。
                  </p>
                </div>
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center justify-end gap-2 border-t bg-muted/30 px-6 py-3">
            <CloseDialogButton onClose={() => setOpen(false)} />
            <SaveSubmitButton disabled={bots.length === 0} />
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
