"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Loader2, Plus, ShieldBan, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * 群组邀请链接管理弹窗（v2.1.2）：
 *
 * Bot API 没有「列出机器人创建的全部邀请链接」的方法，因此依赖台账（invite_links）：
 * - v2.1.2 起 bot 运行时创建的链接（部署管道 / 验证超时补发 / 重新申请）自动落库；
 * - 历史遗留链接（如线上 Edge 平台经 API 创建、无法销毁的 7 条）通过「手动登记」
 *   从 Telegram 客户端（群管理 → 邀请链接列表）粘贴进来，登记后即可一键撤销；
 * - 撤销 = revokeChatInviteLink（Telegram 侧立即作废，已持有者无法再使用）。
 */

interface InviteLinkEntry {
  id: string;
  bot_id: string | null;
  chat_id: string;
  link: string;
  name: string | null;
  creates_join_request: boolean;
  is_revoked: boolean;
  source: string;
  created_time: string;
  updated_time: string;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "-";
  const beijing = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${beijing.getFullYear()}-${String(beijing.getMonth() + 1).padStart(2, "0")}-${String(
    beijing.getDate(),
  ).padStart(2, "0")} ${String(beijing.getHours()).padStart(2, "0")}:${String(beijing.getMinutes()).padStart(2, "0")}`;
}

export function InviteLinksDialog({
  chatId,
  chatTitle,
  bots,
  trigger,
  triggerClassName,
}: {
  chatId: string;
  chatTitle: string;
  /** 该群绑定的机器人（含 id/名称），弹窗内选择要查看的机器人视角 */
  bots: { id: string; name: string }[];
  trigger: React.ReactNode;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [botId, setBotId] = useState(bots[0]?.id ?? "");
  const [links, setLinks] = useState<InviteLinkEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [manualLink, setManualLink] = useState("");
  const [manualAdding, setManualAdding] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const loadLinks = useCallback(async (): Promise<void> => {
    if (!chatId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ chat_id: chatId });
      if (botId) params.set("bot_id", botId);
      const response = await fetch(`/api/admin/telegram/invite-links?${params.toString()}`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        ok: boolean;
        error?: string;
        data?: { links: InviteLinkEntry[] };
      };
      if (!payload.ok) {
        setNotice({ ok: false, text: payload.error ?? "读取邀请链接失败" });
        return;
      }
      setLinks(payload.data?.links ?? []);
    } catch (error) {
      setNotice({ ok: false, text: error instanceof Error ? error.message : "读取邀请链接失败" });
    } finally {
      setLoading(false);
    }
  }, [chatId, botId]);

  useEffect(() => {
    if (open) void loadLinks();
  }, [open, loadLinks]);

  const act = useCallback(
    async (action: "revoke" | "delete", linkId: string): Promise<void> => {
      setBusyId(linkId);
      setNotice(null);
      try {
        const response = await fetch("/api/admin/telegram/invite-links", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, bot_id: botId, action, link_id: linkId }),
        });
        const payload = (await response.json()) as { ok: boolean; error?: string; data?: { message?: string } };
        if (!payload.ok) {
          setNotice({ ok: false, text: payload.error ?? "操作失败" });
          return;
        }
        setNotice({ ok: true, text: payload.data?.message ?? "操作成功" });
        await loadLinks();
      } catch (error) {
        setNotice({ ok: false, text: error instanceof Error ? error.message : "操作失败" });
      } finally {
        setBusyId(null);
      }
    },
    [chatId, botId, loadLinks],
  );

  const addManual = useCallback(async (): Promise<void> => {
    const link = manualLink.trim();
    if (!link || manualAdding) return;
    setManualAdding(true);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/telegram/invite-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, bot_id: botId, action: "add", link }),
      });
      const payload = (await response.json()) as { ok: boolean; error?: string; data?: { message?: string } };
      if (!payload.ok) {
        setNotice({ ok: false, text: payload.error ?? "登记失败" });
        return;
      }
      setNotice({ ok: true, text: payload.data?.message ?? "登记成功" });
      setManualLink("");
      await loadLinks();
    } catch (error) {
      setNotice({ ok: false, text: error instanceof Error ? error.message : "登记失败" });
    } finally {
      setManualAdding(false);
    }
  }, [chatId, botId, manualLink, manualAdding, loadLinks]);

  const copy = useCallback((entry: InviteLinkEntry): void => {
    void navigator.clipboard.writeText(entry.link).then(() => {
      setCopiedId(entry.id);
      setTimeout(() => setCopiedId(null), 1500);
    });
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" className={triggerClassName}>
          {trigger}
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>邀请链接管理 · {chatTitle || chatId}</DialogTitle>
          <DialogDescription>
            查看机器人在该群组创建的全部邀请链接并撤销/清理。Bot API 无法枚举历史链接：
            v2.1.2 起新建的链接自动记录在台账；历史遗留链接（无法销毁的旧链接）可从
            Telegram 客户端「群管理 → 邀请链接」复制后手动登记，再一键撤销作废。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* 机器人视角选择 */}
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-sm font-medium" htmlFor={`invite-bot-${chatId}`}>
              机器人视角
            </label>
            <select
              id={`invite-bot-${chatId}`}
              value={botId}
              onChange={(event) => setBotId(event.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              {bots.length === 0 ? <option value="">（该群暂无机器人绑定）</option> : null}
              {bots.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void loadLinks()}
              disabled={loading || !botId}
              className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm hover:bg-accent disabled:opacity-60"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              刷新
            </button>
          </div>

          {notice ? (
            <div
              role="status"
              className={`rounded-md border px-3 py-2 text-sm ${
                notice.ok
                  ? "border-green-200 bg-green-50 text-green-700"
                  : "border-red-200 bg-red-50 text-red-700"
              }`}
            >
              {notice.text}
            </div>
          ) : null}

          {/* 手动登记历史链接 */}
          <div className="space-y-2 rounded-lg border border-dashed p-3">
            <p className="text-sm font-medium">手动登记历史链接（销毁台账里没有的旧链接）</p>
            <div className="flex gap-2">
              <input
                value={manualLink}
                onChange={(event) => setManualLink(event.target.value)}
                placeholder="https://t.me/+XXXXXXXXXXXX（从 Telegram 群管理 → 邀请链接 复制）"
                className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 font-mono text-xs"
                aria-label="邀请链接地址"
              />
              <button
                type="button"
                onClick={() => void addManual()}
                disabled={manualAdding || !manualLink.trim() || !botId}
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
              >
                {manualAdding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                登记
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              登记后即可执行「撤销」——撤销调用 Telegram revokeChatInviteLink，链接立即作废。
            </p>
          </div>

          {/* 链接列表 */}
          <div className="max-h-96 overflow-y-auto rounded-lg border">
            {loading && links.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                读取中…
              </div>
            ) : links.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                台账中暂无该机器人在此群组的邀请链接记录。
                <br />
                v2.1.2 起机器人新建的链接会自动记录；历史链接请先在上方手动登记。
              </div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">链接</th>
                    <th className="px-3 py-2 font-medium">来源</th>
                    <th className="px-3 py-2 font-medium">创建时间</th>
                    <th className="px-3 py-2 font-medium">状态</th>
                    <th className="px-3 py-2 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {links.map((entry) => (
                    <tr key={entry.id} className="border-b last:border-0 align-top">
                      <td className="max-w-64 px-3 py-2">
                        <p className="truncate font-mono text-xs" title={entry.link}>
                          {entry.link}
                        </p>
                        {entry.name ? (
                          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={entry.name}>
                            {entry.name}
                            {entry.creates_join_request ? " · 申请制" : ""}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {entry.source === "manual" ? "手动登记" : entry.source === "deploy" ? "部署" : "Bot API"}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{formatTime(entry.created_time)}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex rounded-full border px-2 py-0.5 text-xs ${
                            entry.is_revoked
                              ? "border-gray-200 bg-gray-50 text-gray-500"
                              : "border-green-200 bg-green-50 text-green-700"
                          }`}
                        >
                          {entry.is_revoked ? "已撤销/失效" : "有效"}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => copy(entry)}
                            className="inline-flex h-7 items-center gap-1 rounded border px-2 text-xs hover:bg-accent"
                            aria-label="复制链接"
                          >
                            <Copy className="h-3 w-3" />
                            {copiedId === entry.id ? "已复制" : "复制"}
                          </button>
                          {!entry.is_revoked ? (
                            <button
                              type="button"
                              onClick={() => void act("revoke", entry.id)}
                              disabled={busyId === entry.id}
                              className="inline-flex h-7 items-center gap-1 rounded border border-amber-300 px-2 text-xs text-amber-700 hover:bg-amber-50 disabled:opacity-60"
                            >
                              {busyId === entry.id ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <ShieldBan className="h-3 w-3" />
                              )}
                              撤销
                            </button>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => void act("delete", entry.id)}
                            disabled={busyId === entry.id}
                            className="inline-flex h-7 items-center gap-1 rounded border border-red-200 px-2 text-xs text-red-600 hover:bg-red-50 disabled:opacity-60"
                          >
                            <Trash2 className="h-3 w-3" />
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
