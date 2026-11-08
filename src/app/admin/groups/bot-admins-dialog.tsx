"use client";

import { useCallback, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { Loader2, RefreshCw } from "lucide-react";
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
  /** bots.id：回显已保存配置用（v1.2.0） */
  botId: string;
  botName: string;
  botUsername: string | null;
  rights: Record<string, boolean>;
}

/** v2.1.1 实时读取结果（/api/admin/bots/testing/bot-admins?live=1）
 *  group_flags.join_request 为 null 仅表示 getChat 整体失败（不可知）；
 *  Bot API 可选布尔缺省 = false（未开启） */
interface LiveBotState {
  bot_id: string;
  bot_username: string | null;
  status: string;
  is_admin: boolean;
  rights: Record<string, boolean> | null;
  group_flags: {
    join_request: boolean | null;
    join_to_send: boolean | null;
  };
}

/** form 内主提交按钮（v1.2.0）：
 * useFormStatus 读取所属表单的 pending 状态 —— 保存中显示旋转 loading、禁用按钮；
 * 整个弹窗只有一个 form，「关闭」按钮通过同一 pending 状态联动禁用。 */
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

/**
 * 群组机器人管理员弹窗（v2.1.1 真实化重构）：
 *
 * - 勾选回显 = Telegram 实时读取（getChatMember 实际权限），不再是本地保存的旧数据；
 *   实时读取失败时才回退已保存配置，并明确给出错误提示（绝不冒充真实状态）。
 * - 「审批新成员」改为只读真实状态展示（getChat.join_request，Bot API 7.3+）——
 *   Telegram 官方限制该群级开关无法通过 Bot API 远程修改，旧版可点开关纯属误导，已移除。
 * - 保存动作保持真实同步：机器人已是管理员 → 以实际权限为准落库；
 *   尚未是管理员 → 自动尝试通过其它管理员机器人 promoteChatMember 真实提升。
 */
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
  /** 本地记录的「加群需要管理员审核」状态（实时读取失败时的兜底展示） */
  requireApproval?: boolean;
  trigger: React.ReactNode;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  /** 当前选中 bot（受控，v1.2.0）：打开弹窗/切换选项时实时读取该 bot 在 Telegram 的真实权限 */
  const [selectedBotId, setSelectedBotId] = useState("");
  /** 编辑区重建键：每次打开弹窗/实时数据到达时按最新数据重建默认勾选（避免残留旧状态） */
  const [editorResetKey, setEditorResetKey] = useState(0);

  /** v2.1.1 实时状态 */
  const [liveState, setLiveState] = useState<LiveBotState | null>(null);
  const [liveLoading, setLoading] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);

  /** 实时数据到达后重建编辑区：defaultChecked 仅在挂载时生效，
   *  必须换 key 强制重挂才能让 Telegram 实际权限刷新到勾选框 */
  const liveDataArrived = liveState !== null || liveError !== null;
  useEffect(() => {
    if (liveDataArrived) {
      setEditorResetKey((key) => key + 1);
    }
  }, [liveDataArrived, liveState, liveError]);

  /** 初始选中：第一个已在弹窗下拉列表中的已保存管理员；无则选第一个可用 bot */
  const resolveInitialBotId = (): string => {
    for (const admin of admins) {
      if (bots.some((bot) => bot.id === admin.botId)) return admin.botId;
    }
    return bots[0]?.id ?? "";
  };

  const fetchLiveState = useCallback(
    async (botId: string) => {
      if (!botId) return;
      setLoading(true);
      setLiveError(null);
      try {
        const res = await fetch(
          `/api/admin/bots/testing/bot-admins?chat_id=${encodeURIComponent(chatId)}&bot_id=${encodeURIComponent(botId)}&live=1`,
          { cache: "no-store" },
        );
        const payload = (await res.json()) as {
          ok: boolean;
          error?: string;
          data?: LiveBotState;
        };
        if (!payload.ok || !payload.data) {
          setLiveState(null);
          setLiveError(payload.error ?? "实时读取 Telegram 状态失败");
        } else {
          setLiveState(payload.data);
        }
      } catch (error) {
        setLiveState(null);
        setLiveError(error instanceof Error ? error.message : "实时读取 Telegram 状态失败");
      } finally {
        setLoading(false);
      }
    },
    [chatId],
  );

  const handleOpenChange = (next: boolean): void => {
    setOpen(next);
    if (next) {
      const initialBotId = resolveInitialBotId();
      setSelectedBotId(initialBotId);
      setEditorResetKey((key) => key + 1);
      setLiveState(null);
      void fetchLiveState(initialBotId);
    }
  };

  const handleBotChange = (botId: string): void => {
    setSelectedBotId(botId);
    setLiveState(null);
    setEditorResetKey((key) => key + 1);
    void fetchLiveState(botId);
  };

  /** 选中的 bot 是否已有已保存的管理员配置（实时读取失败时的兜底回显） */
  const selectedAdmin = admins.find((admin) => admin.botId === selectedBotId) ?? null;

  /** 勾选数据源：实时读取成功 → Telegram 实际权限；失败 → 已保存配置（附明确提示） */
  const checkedRights: Record<string, boolean> = liveState?.is_admin && liveState.rights
    ? liveState.rights
    : selectedAdmin?.rights ?? {};

  /** 「审批新成员」只读真实状态：实时字段优先（缺省=false 未开启，null 仅在 getChat
   *  整体失败时出现），读取失败时回退本地记录 */
  const approvalUnknown = liveState ? liveState.group_flags.join_request === null : liveError !== null;
  const approvalOn = liveState
    ? liveState.group_flags.join_request === true
    : requireApproval;

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
            勾选状态实时读取自 Telegram（getChatMember 实际权限）；保存时尚未是管理员的机器人会自动尝试通过其它管理员机器人真实提升（Telegram 限制机器人无法自我提升）。
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
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">添加 / 更新机器人管理员</p>
                  <button
                    type="button"
                    onClick={() => void fetchLiveState(selectedBotId)}
                    disabled={liveLoading || !selectedBotId}
                    className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs text-muted-foreground hover:bg-accent disabled:opacity-60"
                  >
                    {liveLoading ? (
                      <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                    ) : (
                      <RefreshCw className="h-3 w-3" aria-hidden="true" />
                    )}
                    重新读取 Telegram
                  </button>
                </div>
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
                    onChange={(event) => handleBotChange(event.target.value)}
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {bots.map((bot) => (
                      <option key={bot.id} value={bot.id}>
                        {bot.name}
                        {bot.username ? `（@${bot.username}）` : ""}
                      </option>
                    ))}
                  </select>
                  {/* v2.1.1 实时读取状态条：明确区分「Telegram 实时」与「本地兜底」两种数据源 */}
                  {liveLoading ? (
                    <p className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                      正在读取 Telegram 实时状态…
                    </p>
                  ) : liveError ? (
                    <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
                      实时读取失败：{liveError}。以下勾选为本地保存的配置（仅供参考，不代表 Telegram 当前状态）。
                    </p>
                  ) : liveState?.is_admin ? (
                    <p className="text-xs text-emerald-700">
                      ✓ 已实时读取 Telegram：该机器人是本群管理员，以下勾选 = 当前实际权限。Telegram 限制机器人无法修改自己的权限，如需调整请在 TG 客户端群设置 → 管理员中修改后点击「重新读取」。
                    </p>
                  ) : liveState ? (
                    <p className="text-xs text-amber-700">
                      已实时读取 Telegram：该机器人当前还不是本群管理员（状态：{liveState.status}）。保存时将自动尝试通过其它管理员机器人提升；无可用提升者时会给出手动操作指引。
                    </p>
                  ) : null}
                </div>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  {RIGHTS.map((right) => (
                    <label key={right.key} className="flex items-center gap-2 rounded-md p-2 text-sm hover:bg-accent">
                      <input
                        type="checkbox"
                        name={right.key}
                        value="1"
                        defaultChecked={checkedRights[right.key] === true}
                        className="h-4 w-4"
                      />
                      <span>{right.label}</span>
                    </label>
                  ))}
                </div>
                {/* v2.1.1：「审批新成员」改为只读真实状态展示 —— Bot API 官方无法远程修改该
                    群级开关，旧版可点开关纯属误导（假功能），已按只读重建 */}
                <div className="space-y-2 border-t pt-3">
                  <p className="text-sm font-medium">加群审核（审批新成员）</p>
                  <div className="rounded-md border bg-background p-3">
                    {approvalUnknown ? (
                      <p className="text-sm text-muted-foreground">
                        Telegram 当前状态未知（实时读取失败）。
                      </p>
                    ) : (
                      <p className="text-sm">
                        当前状态：
                        <span className={approvalOn ? "font-medium text-emerald-700" : "font-medium text-muted-foreground"}>
                          {approvalOn ? "已开启（用户入群需先提交申请）" : "未开启（普通链接可直接进群）"}
                        </span>
                      </p>
                    )}
                    <p className="mt-1 text-xs text-muted-foreground">
                      该开关由 Telegram 客户端群设置 → 权限 → 「审批新成员」控制，Bot API 官方限制无法远程读取修改（此处为只读展示）。
                      本系统生成的入群申请链接始终强制需审批；普通链接直接入群的用户也会被私聊补验证（超时/失败自动移出）。
                    </p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    保存时真实同步：机器人已是管理员 → 读取并以 Telegram 实际权限为准保存；尚未是管理员 → 自动尝试通过其它管理员机器人提升；均不可用时给出手动操作指引。
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
