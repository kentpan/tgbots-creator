"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Clock, Copy, Link2, Loader2, Pencil, Plus, Users } from "lucide-react";

/** 台账链接条目（GET /api/admin/telegram/invite-links 返回结构） */
interface InviteLinkEntry {
  id: string;
  link: string;
  remark?: string | null;
  name?: string | null;
  creates_join_request: boolean;
  is_revoked: boolean;
  expire_date?: string | null;
  member_limit?: number | null;
  chat_is_private?: boolean | null;
  created_time: string;
}

interface ChatInfo {
  is_private: boolean | null;
  require_approval: boolean;
}

/** 分享时长选项（秒；null = 不限时长） */
const EXPIRE_OPTIONS: { label: string; value: number | null }[] = [
  { label: "不限时长", value: null },
  { label: "1 小时", value: 60 * 60 },
  { label: "24 小时", value: 60 * 60 * 24 },
  { label: "7 天", value: 60 * 60 * 24 * 7 },
  { label: "30 天", value: 60 * 60 * 24 * 30 },
  { label: "90 天", value: 60 * 60 * 24 * 90 },
];

/** 分享次数选项（null = 不限次数；Telegram 上限 99999） */
const MEMBER_LIMIT_OPTIONS: { label: string; value: number | null }[] = [
  { label: "不限次数", value: null },
  { label: "1 人", value: 1 },
  { label: "5 人", value: 5 },
  { label: "10 人", value: 10 },
  { label: "50 人", value: 50 },
  { label: "100 人", value: 100 },
  { label: "500 人", value: 500 },
];

function formatExpire(iso: string | null | undefined): string {
  if (!iso) return "不限时长";
  const date = new Date(iso);
  return `至 ${date.toLocaleString()}`;
}

function tagClass(active: boolean): string {
  return `rounded-full px-2 py-0.5 text-[11px] font-medium ${
    active ? "bg-[#3390ec]/10 text-[#3390ec]" : "bg-black/[0.06] text-[#8e8e93]"
  }`;
}

/**
 * v3.0.4 群组行「生成邀请链接」按钮（替代原分体部署按钮）：
 * - 基于当前群组 + 当前选中的机器人；
 * - 弹窗顶部展示当前群组：私密/公开 · 新成员审核开启/关闭；
 * - 创建时可配置分享时长（默认不限）与分享次数（默认不限）；
 * - 台账列表：备注醒目标题 + 私密/公开、是否需审核、时长、次数标签，可复制、可编辑。
 */
export function GroupInviteLinkButton({
  chatId,
  chatTitle,
  botId,
  botName,
  showFlash,
}: {
  chatId: string;
  chatTitle: string | null;
  botId: string;
  botName?: string | null;
  showFlash: (ok: boolean, text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [links, setLinks] = useState<InviteLinkEntry[]>([]);
  const [chatInfo, setChatInfo] = useState<ChatInfo | null>(null);
  const [loading, setLoading] = useState(false);

  // —— 创建表单（默认：不限时长 + 不限次数）——
  const [remark, setRemark] = useState("");
  const [expireOption, setExpireOption] = useState<number | null>(null);
  const [limitOption, setLimitOption] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  // —— 行内编辑 ——
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRemark, setEditRemark] = useState("");
  const [editExpire, setEditExpire] = useState<number | null>(null);
  const [editLimit, setEditLimit] = useState<number | null>(null);
  const [editBusy, setEditBusy] = useState(false);

  const [copiedId, setCopiedId] = useState<string | null>(null);

  const loadLinks = useCallback(async (): Promise<void> => {
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
        data?: { chat_info?: ChatInfo; links?: InviteLinkEntry[] };
      };
      if (!payload.ok) {
        showFlash(false, payload.error ?? "读取邀请链接失败");
        return;
      }
      setLinks(payload.data?.links ?? []);
      setChatInfo(payload.data?.chat_info ?? null);
    } catch (error) {
      showFlash(false, error instanceof Error ? error.message : "读取邀请链接失败");
    } finally {
      setLoading(false);
    }
  }, [botId, chatId, showFlash]);

  // 每次打开弹窗重新拉取（台账是活数据：期间可能新增/编辑/撤销了链接）
  useEffect(() => {
    if (open) void loadLinks();
  }, [open, loadLinks]);

  const createLink = useCallback(async (): Promise<void> => {
    if (!botId || creating) return;
    setCreating(true);
    try {
      const response = await fetch("/api/admin/telegram/invite-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          bot_id: botId,
          action: "create",
          remark: remark.trim(),
          expire_seconds: expireOption ?? 0,
          member_limit: limitOption ?? 0,
        }),
      });
      const payload = (await response.json()) as {
        ok: boolean;
        error?: string;
        data?: { message?: string; link?: string };
      };
      if (!payload.ok) {
        showFlash(false, payload.error ?? "创建邀请链接失败");
        return;
      }
      showFlash(true, payload.data?.message ?? "邀请链接已生成");
      setRemark("");
      await loadLinks();
    } catch (error) {
      showFlash(false, error instanceof Error ? error.message : "创建邀请链接失败");
    } finally {
      setCreating(false);
    }
  }, [botId, chatId, creating, expireOption, limitOption, loadLinks, remark, showFlash]);

  const startEdit = useCallback((entry: InviteLinkEntry): void => {
    setEditingId(entry.id);
    setEditRemark(entry.remark ?? "");
    // 已设置的时长/次数回填为最接近的选项（Telegram 限制：只能改值，无法清除）
    setEditExpire(null);
    setEditLimit(null);
  }, []);

  const submitEdit = useCallback(
    async (entry: InviteLinkEntry): Promise<void> => {
      if (editBusy) return;
      setEditBusy(true);
      try {
        const response = await fetch("/api/admin/telegram/invite-links", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            bot_id: botId,
            action: "edit",
            link_id: entry.id,
            remark: editRemark.trim(),
            expire_seconds: editExpire ?? 0,
            member_limit: editLimit ?? 0,
          }),
        });
        const payload = (await response.json()) as {
          ok: boolean;
          error?: string;
          data?: { message?: string };
        };
        if (!payload.ok) {
          showFlash(false, payload.error ?? "编辑邀请链接失败");
          return;
        }
        showFlash(true, payload.data?.message ?? "邀请链接配置已更新");
        setEditingId(null);
        await loadLinks();
      } catch (error) {
        showFlash(false, error instanceof Error ? error.message : "编辑邀请链接失败");
      } finally {
        setEditBusy(false);
      }
    },
    [botId, chatId, editBusy, editExpire, editLimit, editRemark, loadLinks, showFlash],
  );

  const copyLink = useCallback((entry: { id: string; link: string }): void => {
    void navigator.clipboard.writeText(entry.link);
    setCopiedId(entry.id);
    window.setTimeout(() => setCopiedId((prev) => (prev === entry.id ? null : prev)), 2000);
  }, []);

  const activeLinks = links.filter((entry) => !entry.is_revoked);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-colors hover:brightness-95 disabled:opacity-60"
        style={{ backgroundColor: "rgba(51, 144, 236, 0.1)", color: "#3390ec" }}
        title="生成或复制该群组的邀请链接（当前机器人）"
        disabled={!botId}
      >
        <Link2 className="h-3.5 w-3.5" />
        生成邀请链接
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-label="邀请链接"
        >
          <div
            className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="shrink-0 border-b border-black/[0.06] px-5 py-4">
              <p className="text-[16px] font-semibold text-black">邀请链接</p>
              <p className="mt-0.5 truncate text-[12px] text-[#8e8e93]">
                {chatTitle ?? chatId}
                {botName ? ` · ${botName}` : ""}
              </p>
              {/* v3.0.4：当前群组私密/公开 + 新成员审核状态 */}
              {chatInfo ? (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className={tagClass(true)}>
                    {chatInfo.is_private === null ? "群组类型未知" : chatInfo.is_private ? "🔒 私密群" : "🌐 公开群"}
                  </span>
                  <span className={chatInfo.require_approval ? tagClass(true) : tagClass(false)}>
                    新成员审核：{chatInfo.require_approval ? "已开启" : "未开启"}
                  </span>
                </div>
              ) : null}
            </div>

            {/* 创建表单：备注 + 分享时长 + 分享次数（默认均不限） */}
            <div className="shrink-0 space-y-2 border-b border-black/[0.06] bg-black/[0.02] px-5 py-3">
              <input
                type="text"
                value={remark}
                onChange={(event) => setRemark(event.target.value)}
                placeholder="备注（区分来源渠道，如：闲鱼店铺A）—— 将作为链接名称，创建后醒目展示"
                className="w-full rounded-lg border border-[#3390ec]/40 bg-white px-3 py-2 text-[13px] text-black outline-none placeholder:text-[#b0b0b5] focus:border-[#3390ec]"
              />
              <div className="flex items-center gap-2">
                <select
                  value={expireOption === null ? "unlimited" : String(expireOption)}
                  onChange={(event) =>
                    setExpireOption(event.target.value === "unlimited" ? null : Number(event.target.value))
                  }
                  className="h-8 flex-1 rounded-lg border border-black/10 bg-white px-2 text-[13px] text-black outline-none"
                  aria-label="分享时长"
                >
                  {EXPIRE_OPTIONS.map((option) => (
                    <option key={option.label} value={option.value === null ? "unlimited" : String(option.value)}>
                      时长：{option.label}
                    </option>
                  ))}
                </select>
                <select
                  value={limitOption === null ? "unlimited" : String(limitOption)}
                  onChange={(event) =>
                    setLimitOption(event.target.value === "unlimited" ? null : Number(event.target.value))
                  }
                  className="h-8 flex-1 rounded-lg border border-black/10 bg-white px-2 text-[13px] text-black outline-none"
                  aria-label="分享次数"
                >
                  {MEMBER_LIMIT_OPTIONS.map((option) => (
                    <option key={option.label} value={option.value === null ? "unlimited" : String(option.value)}>
                      次数：{option.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void createLink()}
                  disabled={creating || !botId}
                  className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1 rounded-lg px-3 text-[13px] font-medium text-white transition-transform active:scale-95 disabled:opacity-50"
                  style={{ backgroundColor: "#3390ec" }}
                >
                  {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                  生成
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
              {loading ? (
                <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-[#8e8e93]">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  正在读取邀请链接…
                </div>
              ) : activeLinks.length === 0 ? (
                <p className="py-8 text-center text-[13px] leading-relaxed text-[#8e8e93]">
                  还没有可用的邀请链接，填写配置后点击「生成」。
                </p>
              ) : (
                <div className="space-y-2">
                  {activeLinks.map((entry) => (
                    <div key={entry.id} className="rounded-xl border border-black/[0.08] p-3">
                      {/* v3.0.4：备注醒目展示（标题行，蓝底加粗；无备注回落链接名） */}
                      <div className="mb-1.5 flex items-center gap-2">
                        <span className="inline-flex shrink-0 items-center rounded-md bg-[#3390ec] px-2 py-0.5 text-[12px] font-semibold text-white">
                          {entry.remark || entry.name || "未命名链接"}
                        </span>
                        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                          <span className={tagClass(true)}>
                            {entry.chat_is_private === null || entry.chat_is_private === undefined
                              ? "群组类型未知"
                              : entry.chat_is_private
                                ? "🔒 私密"
                                : "🌐 公开"}
                          </span>
                          <span className={entry.creates_join_request ? tagClass(true) : tagClass(false)}>
                            {entry.creates_join_request ? "需审核" : "免审核"}
                          </span>
                          <span className={tagClass(false)}>
                            <Clock className="mr-0.5 inline h-3 w-3" />
                            {formatExpire(entry.expire_date)}
                          </span>
                          <span className={tagClass(false)}>
                            <Users className="mr-0.5 inline h-3 w-3" />
                            {entry.member_limit ? `限 ${entry.member_limit} 人` : "不限次数"}
                          </span>
                        </div>
                      </div>
                      <code className="block truncate font-mono text-[12px] text-black" title={entry.link}>
                        {entry.link}
                      </code>
                      {editingId === entry.id ? (
                        <div className="mt-2 space-y-2 rounded-lg bg-black/[0.03] p-2.5">
                          <input
                            type="text"
                            value={editRemark}
                            onChange={(event) => setEditRemark(event.target.value)}
                            placeholder="备注（区分来源渠道）"
                            className="w-full rounded-lg border border-black/10 bg-white px-2.5 py-1.5 text-[13px] text-black outline-none focus:border-[#3390ec]"
                          />
                          <div className="flex items-center gap-2">
                            <select
                              value={editExpire === null ? "keep" : String(editExpire)}
                              onChange={(event) =>
                                setEditExpire(event.target.value === "keep" ? null : Number(event.target.value))
                              }
                              className="h-8 flex-1 rounded-lg border border-black/10 bg-white px-2 text-[13px] text-black outline-none"
                              aria-label="修改分享时长"
                            >
                              <option value="keep">时长：保持不变（{formatExpire(entry.expire_date)}）</option>
                              {EXPIRE_OPTIONS.map((option) => (
                                <option
                                  key={option.label}
                                  value={option.value === null ? "unlimited" : String(option.value)}
                                >
                                  改为：{option.label}
                                  {option.value === null ? "（Telegram 限制：已设置的到期时间无法清除）" : ""}
                                </option>
                              ))}
                            </select>
                            <select
                              value={editLimit === null ? "keep" : String(editLimit)}
                              onChange={(event) =>
                                setEditLimit(event.target.value === "keep" ? null : Number(event.target.value))
                              }
                              className="h-8 flex-1 rounded-lg border border-black/10 bg-white px-2 text-[13px] text-black outline-none"
                              aria-label="修改分享次数"
                            >
                              <option value="keep">次数：保持不变（{entry.member_limit ?? "不限"}）</option>
                              {MEMBER_LIMIT_OPTIONS.map((option) => (
                                <option
                                  key={option.label}
                                  value={option.value === null ? "unlimited" : String(option.value)}
                                >
                                  改为：{option.label}
                                  {option.value === null ? "（Telegram 限制：已设置的次数无法清除）" : ""}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="flex items-center justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setEditingId(null)}
                              className="cursor-pointer rounded-full bg-black/[0.06] px-3 py-1.5 text-[12px] font-medium text-black"
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              onClick={() => void submitEdit(entry)}
                              disabled={editBusy}
                              className="inline-flex cursor-pointer items-center gap-1 rounded-full px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-50"
                              style={{ backgroundColor: "#3390ec" }}
                            >
                              {editBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                              保存
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="mt-2 flex items-center justify-between gap-2">
                          <span className="min-w-0 flex-1 truncate text-[11px] text-[#8e8e93]">
                            {entry.created_time ? new Date(entry.created_time).toLocaleString() : ""}
                          </span>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => startEdit(entry)}
                              className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-black/[0.06] px-3 py-1.5 text-[12px] font-medium text-black transition-transform active:scale-95"
                            >
                              <Pencil className="h-3 w-3" />
                              编辑
                            </button>
                            <button
                              type="button"
                              onClick={() => copyLink(entry)}
                              className="inline-flex cursor-pointer items-center gap-1 rounded-full px-3 py-1.5 text-[12px] font-medium text-white transition-transform active:scale-95"
                              style={{ backgroundColor: copiedId === entry.id ? "#34c759" : "#3390ec" }}
                            >
                              {copiedId === entry.id ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                              {copiedId === entry.id ? "已复制" : "复制"}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="shrink-0 border-t border-black/[0.06] px-5 py-4">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="w-full cursor-pointer rounded-full bg-black/[0.06] py-2.5 text-[14px] font-medium text-black transition-transform active:scale-95"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
