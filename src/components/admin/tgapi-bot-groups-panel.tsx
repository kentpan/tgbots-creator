"use client";

import { useRealGroups } from "@/components/admin/use-real-groups";

/**
 * TGAPI 申请机器人配置弹窗内的「真实群组」面板（v2.1.9）。
 *
 * 复用全站唯一获取通道（useRealGroups Hook + /api/admin/telegram/real-groups，
 * 与机器人测试页/编辑机器人弹窗同一实现，不维护第二套同步代码）：
 * - 打开弹窗时只调 GET 读取数据库已登记群组（零 Telegram 请求）；
 *   Radix Dialog 关闭时 Content 不挂载，本面板随弹窗打开才挂载发起请求（天然懒加载）。
 * - 只有用户点「同步真实群组」按钮才调 POST 实时请求 Telegram
 *   （getUpdates + 数据库关联 + getChat 三源合并），结果如实展示，
 *   未发现/校验失败的原因原文透出 —— 配置不再是黑盒。
 */
export function TgApiBotGroupsPanel({ botId }: { botId: string }) {
  const realGroups = useRealGroups({ botId, enabled: true });
  return (
    <div className="rounded-lg border bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">🧭 机器人所在真实群组</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            打开弹窗展示已登记的群组（本地数据库，不请求 Telegram）；点「同步真实群组」才实时调用
            Bot API（getUpdates + getChat）发现并校验，结果如实展示。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void realGroups.sync()}
          disabled={realGroups.syncing}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2.5 text-xs font-medium hover:bg-accent disabled:opacity-50"
        >
          {realGroups.syncing ? "同步中…" : "⟳ 同步真实群组"}
        </button>
      </div>
      {realGroups.groups.length > 0 ? (
        <div className="mt-2 max-h-40 space-y-1 overflow-y-auto pr-1">
          {realGroups.groups.map((group) => (
            <div
              key={group.chatId}
              className="flex items-center justify-between gap-2 rounded-md border bg-background px-3 py-1.5 text-xs"
            >
              <span className="min-w-0 truncate font-medium">
                {group.chatTitle || `群组 ${group.chatId}`}
              </span>
              <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                <span className="font-mono">{group.chatId}</span>
                <span className="rounded-full border bg-muted/40 px-1.5 py-0.5 text-[10px]">
                  {group.source === "updates"
                    ? "getUpdates 新发现"
                    : group.source === "getchat"
                      ? "getChat 验证"
                      : "已登记"}
                </span>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 rounded-md border border-dashed bg-background px-3 py-2 text-xs text-muted-foreground">
          {realGroups.loading
            ? "正在读取已登记的群组…"
            : realGroups.syncing
              ? "正在通过 Bot Token 同步真实群组…"
              : "尚未登记群组：TGAPI 申请机器人是纯私聊工具机器人，没有被拉进群组时此处为空属正常现象；点「同步真实群组」可用 Bot Token 实时确认。"}
        </p>
      )}
      {realGroups.note ? (
        <p className={`mt-1.5 text-xs ${realGroups.note.ok ? "text-green-700" : "text-red-600"}`}>
          {realGroups.note.ok ? "✓ " : "⚠ "}
          {realGroups.note.text}
        </p>
      ) : null}
    </div>
  );
}
