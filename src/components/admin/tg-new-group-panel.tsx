"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { IOS_BLUE, IOS_GREEN, IOS_GRAY_BG, IOS_TEXT_SECONDARY } from "@/components/admin/tg-app-simulator-primitives";

/**
 * 新建群组面板（v2.0.15，机器人测试页仿真屏「新建会话」按钮 → 左滑滑入）。
 *
 * 复刻 Telegram「新建群组」流程（截图4）并把「选择用户」替换为「选择机器人」：
 * ① 机器人列表（已有机器人，头像+名称+@username，点选高亮）→ ② 下一步 →
 * 输入群组名称 → 确定。
 *
 * 真实边界（诚实实现）：Bot API 无建群方法（群组只能由用户客户端创建），确定后：
 * - 服务端 getMe 实时校验所选机器人 Token（真实 Telegram 请求，经代理链路）；
 * - 登记「待绑定群组」（telegram.pending_groups）并返回喂饭级建群指引；
 * - 用户在 Telegram App 建同名群组并把机器人拉入后，点「同步真实群组」即自动绑定。
 * 面板底部展示该机器人的待绑定条目（等待创建中），可手动删除。
 */


const NAME_COLORS = ["#e17076", "#faa774", "#a695e7", "#7bc862", "#6ec9cb", "#65aadd", "#ee7aae"];

function nameColor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return NAME_COLORS[hash % NAME_COLORS.length];
}

export interface NewGroupBot {
  id: string;
  name: string;
  username: string | null;
  tokenMasked: string;
}

interface PendingGroup {
  id: string;
  bot_id: string;
  bot_username: string | null;
  title: string;
  created_at: string;
}

async function readJson<T>(response: Response): Promise<T | null> {
  try {
    const text = await response.text();
    if (!text.trim()) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function TgNewGroupPanel({
  bots,
  onClose,
  onNotify,
  onMutated,
}: {
  bots: NewGroupBot[];
  onClose: () => void;
  onNotify: (ok: boolean, text: string) => void;
  /** 创建/删除成功后通知父组件（预留刷新钩子） */
  onMutated?: () => void;
}) {
  const [step, setStep] = useState<"bots" | "title" | "done">("bots");
  const [selectedBotId, setSelectedBotId] = useState<string>("");
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingGroup[]>([]);
  const [pendingLoading, setPendingLoading] = useState(true);
  const [result, setResult] = useState<{ title: string; guide: string[]; note: string } | null>(null);

  const loadPending = useCallback(async (): Promise<void> => {
    setPendingLoading(true);
    try {
      const response = await fetch("/api/admin/bots/testing/create-group", { cache: "no-store" });
      const payload = await readJson<{ ok: boolean; data?: { pending: PendingGroup[] } }>(response);
      setPending(payload?.ok ? payload.data?.pending ?? [] : []);
    } catch {
      setPending([]);
    } finally {
      setPendingLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPending();
  }, [loadPending]);

  const selectedBot = bots.find((bot) => bot.id === selectedBotId) ?? null;

  const createGroup = useCallback(async (): Promise<void> => {
    const trimmed = title.trim();
    if (!selectedBotId || !trimmed) {
      setError("请输入群组名称");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/bots/testing/create-group", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bot_id: selectedBotId, title: trimmed }),
      });
      const payload = await readJson<{
        ok: boolean;
        error?: string;
        data?: { title: string; guide: string[]; note: string };
      }>(response);
      if (!payload) {
        setError(`服务返回异常（HTTP ${response.status}），请查看服务端日志后重试`);
        return;
      }
      if (!payload.ok || !payload.data) {
        setError(payload.error ?? "登记失败");
        return;
      }
      setResult({ title: payload.data.title, guide: payload.data.guide, note: payload.data.note });
      setStep("done");
      onMutated?.();
      void loadPending();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "登记失败");
    } finally {
      setCreating(false);
    }
  }, [title, selectedBotId, onMutated, loadPending]);

  const removePending = useCallback(
    async (id: string): Promise<void> => {
      try {
        await fetch(`/api/admin/bots/testing/create-group?id=${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        await loadPending();
      } catch {
        /* 列表刷新失败不打断 */
      }
    },
    [loadPending],
  );

  return (
    <div className="flex h-full flex-col" style={{ backgroundColor: IOS_GRAY_BG }}>
      {/* 顶部：返回 + 标题 + 下一步/创建（复刻图4「选择用户 0/200,000 … 下一步」结构） */}
      <div className="flex items-center border-b border-black/[0.06] bg-white/85 px-3 py-2 backdrop-blur">
        <button
          type="button"
          onClick={() => {
            if (step === "done") {
              onClose();
              return;
            }
            if (step === "title") {
              setStep("bots");
              return;
            }
            onClose();
          }}
          aria-label={step === "title" ? "返回选择机器人" : "关闭新建群组"}
          className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-black/[0.06] text-black transition-transform active:scale-95"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <span className="flex-1 text-center text-[17px] font-semibold text-black">
          {step === "bots" ? "新建群组" : step === "title" ? "群组信息" : "已登记"}
        </span>
        {step === "bots" ? (
          <button
            type="button"
            onClick={() => {
              if (!selectedBotId) return;
              setError(null);
              setStep("title");
            }}
            disabled={!selectedBotId}
            aria-label="下一步"
            className="cursor-pointer text-[16px] font-semibold disabled:opacity-40"
            style={{ color: IOS_BLUE }}
          >
            下一步
          </button>
        ) : step === "title" ? (
          <button
            type="button"
            onClick={() => void createGroup()}
            disabled={creating || !title.trim()}
            aria-label="确定创建"
            className="flex cursor-pointer items-center gap-1.5 text-[16px] font-semibold disabled:opacity-40"
            style={{ color: IOS_BLUE }}
          >
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            确定
          </button>
        ) : (
          <span className="h-9 w-9" aria-hidden />
        )}
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {step === "bots" ? (
          <>
            <p className="px-1 text-[13px]" style={{ color: IOS_TEXT_SECONDARY }}>
              选择要绑定新群组的机器人（与 APP「选择用户」同布局，成员改为机器人列表）
            </p>
            <div className="overflow-hidden rounded-xl bg-white">
              {bots.length === 0 ? (
                <div className="px-4 py-8 text-center text-[14px]" style={{ color: IOS_TEXT_SECONDARY }}>
                  尚未创建机器人：请先在「机器人管理」中添加
                </div>
              ) : (
                bots.map((bot, index) => {
                  const isSelected = bot.id === selectedBotId;
                  return (
                    <button
                      key={bot.id}
                      type="button"
                      onClick={() => setSelectedBotId(bot.id)}
                      aria-pressed={isSelected}
                      className={`flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors ${
                        index > 0 ? "border-t border-black/[0.06]" : ""
                      } ${isSelected ? "bg-[#3390ec]/[0.08]" : "hover:bg-black/[0.03]"}`}
                    >
                      <span
                        className="flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-full text-[18px] font-semibold text-white"
                        style={{ backgroundColor: nameColor(bot.name) }}
                        aria-hidden
                      >
                        {bot.name.slice(0, 1)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[16px] font-medium text-black">{bot.name}</span>
                        <span className="block truncate text-[13.5px]" style={{ color: IOS_TEXT_SECONDARY }}>
                          {bot.username ? `@${bot.username}` : "未获取用户名"} · {bot.tokenMasked}
                        </span>
                      </span>
                      {isSelected ? (
                        <span
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-white"
                          style={{ backgroundColor: IOS_BLUE }}
                          aria-hidden
                        >
                          <Check className="h-4 w-4" />
                        </span>
                      ) : (
                        <ChevronRight className="h-4 w-4 shrink-0 text-[#c7c7cc]" aria-hidden />
                      )}
                    </button>
                  );
                })
              )}
            </div>

            {/* 待绑定群组（已登记等待真实群组落地） */}
            <div className="overflow-hidden rounded-xl bg-white">
              <div className="px-4 pt-3 pb-1 text-[13px]" style={{ color: IOS_TEXT_SECONDARY }}>
                待绑定群组（已登记，等待真实群组落地后自动绑定）
              </div>
              {pendingLoading ? (
                <div className="flex justify-center py-4">
                  <Loader2 className="h-5 w-5 animate-spin text-[#8e8e93]" />
                </div>
              ) : pending.length === 0 ? (
                <div className="px-4 py-3 text-[14px]" style={{ color: IOS_TEXT_SECONDARY }}>
                  暂无待绑定群组
                </div>
              ) : (
                pending.map((item, index) => (
                  <div
                    key={item.id}
                    className={`flex items-center gap-3 px-4 py-2.5 ${index > 0 ? "border-t border-black/[0.06]" : ""}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15.5px] text-black">{item.title}</span>
                      <span className="block truncate text-[12.5px]" style={{ color: IOS_TEXT_SECONDARY }}>
                        @{item.bot_username ?? "bot"} · 等待创建/绑定
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => void removePending(item.id)}
                      aria-label={`删除待绑定群组 ${item.title}`}
                      className="shrink-0 cursor-pointer text-[13px] font-medium"
                      style={{ color: IOS_BLUE }}
                    >
                      删除
                    </button>
                  </div>
                ))
              )}
            </div>
          </>
        ) : null}

        {step === "title" ? (
          <>
            {selectedBot ? (
              <div className="flex items-center gap-3 rounded-xl bg-white px-4 py-3">
                <span
                  className="flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-full text-[18px] font-semibold text-white"
                  style={{ backgroundColor: nameColor(selectedBot.name) }}
                  aria-hidden
                >
                  {selectedBot.name.slice(0, 1)}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-[16px] font-medium text-black">{selectedBot.name}</p>
                  <p className="truncate text-[13.5px]" style={{ color: IOS_TEXT_SECONDARY }}>
                    {selectedBot.username ? `@${selectedBot.username}` : "未获取用户名"}
                  </p>
                </div>
              </div>
            ) : null}

            <div className="rounded-xl bg-white px-4 py-3">
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="输入群组名称"
                aria-label="群组名称"
                maxLength={128}
                autoFocus
                className="w-full bg-transparent text-[17px] text-black outline-none placeholder:text-[#8e8e93]"
              />
            </div>
            <p className="px-1 text-[12.5px] leading-relaxed" style={{ color: IOS_TEXT_SECONDARY }}>
              点击「确定」后：系统将真实调用 Telegram 校验该机器人 Token，并按机器人 + 群名登记待绑定群组；
              Telegram 官方限制机器人无法凭空建群 —— 请按指引在 Telegram App 中新建同名群组并把机器人拉入，
              回到本页点「同步真实群组」即自动绑定。
            </p>
            {error ? <p className="px-1 text-[13px] text-red-600">{error}</p> : null}
          </>
        ) : null}

        {step === "done" && result ? (
          <>
            <div className="flex flex-col items-center rounded-xl bg-white px-4 py-6">
              <span
                className="flex h-14 w-14 items-center justify-center rounded-full text-white"
                style={{ backgroundColor: IOS_GREEN }}
                aria-hidden
              >
                <Check className="h-7 w-7" />
              </span>
              <p className="mt-3 text-center text-[17px] font-semibold text-black">
                已登记新建群组「{result.title}」
              </p>
              <p className="mt-1.5 text-center text-[12.5px] leading-relaxed" style={{ color: IOS_TEXT_SECONDARY }}>
                {result.note}
              </p>
            </div>
            <div className="rounded-xl bg-white px-4 py-3">
              <p className="pb-2 text-[13px] font-medium text-black">下一步操作</p>
              <ol className="list-decimal space-y-1.5 pl-4 text-[13.5px] leading-relaxed text-[#3b4a54]">
                {result.guide.map((step, index) => (
                  <li key={index}>{step}</li>
                ))}
              </ol>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="w-full cursor-pointer rounded-full py-3 text-[16px] font-semibold text-white transition-transform active:scale-[0.99]"
              style={{ backgroundColor: IOS_BLUE }}
            >
              知道了
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
