"use client";

import { Switch } from "@/components/ui/switch";

/**
 * v3.0.4 通用验证交互开关（消息内嵌按钮 / 自定义键盘 / 指令菜单面板共用）：
 *
 * - 使用私聊回复：开启后点击验证按钮（群内）时机器人改在私聊发送验证提示，
 *   用户在私聊对话中回复验证码完成验证（私聊内容群友不可见）；
 *   关闭则在当前会话（群内 force-reply）直接回复验证码。
 * - 锁定用户回复：开启后只有点击按钮发起验证的用户回复才有效，
 *   其他成员的回复不消耗次数、不产生任何验证结果（防代验）。
 *
 * 数据模型：验证按钮的 action.verify.private_reply / action.verify.lock_user
 * （MenuVerifyConfig，随菜单/键盘配置 JSON 一并保存）。
 */
export function InteractionModeSwitches({
  privateReply,
  lockUser,
  onPrivateReplyChange,
  onLockUserChange,
}: {
  privateReply: boolean;
  lockUser: boolean;
  onPrivateReplyChange: (value: boolean) => void;
  onLockUserChange: (value: boolean) => void;
}) {
  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
      <p className="text-sm font-medium">验证交互方式</p>
      <label className="flex cursor-pointer items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-sm font-medium">💬 使用私聊回复</span>
          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
            开启：点击按钮后机器人私聊发送验证提示，用户在私聊对话中输入验证码（群友不可见）；
            关闭：直接在当前会话（群内 force-reply 输入框）回复验证码。
          </span>
        </span>
        <Switch
          checked={privateReply}
          onCheckedChange={onPrivateReplyChange}
          aria-label="使用私聊回复"
        />
      </label>
      <label className="flex cursor-pointer items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-sm font-medium">🔒 锁定用户回复</span>
          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
            开启：只有点击按钮发起验证的用户回复才有效，其他成员回复不计次、不产生验证结果（防代验）。
          </span>
        </span>
        <Switch
          checked={lockUser}
          onCheckedChange={onLockUserChange}
          aria-label="锁定用户回复"
        />
      </label>
    </div>
  );
}
