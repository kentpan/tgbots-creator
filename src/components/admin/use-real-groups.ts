"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * 统一「真实群组」获取 Hook（v1.1.1）：
 *
 * 全站唯一的客户端获取逻辑 —— 机器人测试页、编辑机器人弹窗等所有需要
 * 「机器人真实所在群组」的界面共用本 Hook + /api/admin/telegram/real-groups，
 * 不再各自维护一套同步代码。
 *
 * 行为约定（重要）：
 * - 打开页面/弹窗时只调 GET 读取数据库已登记群组（零 Telegram 请求），
 *   已有数据立即展示；没有数据就展示空态引导手动同步。
 * - 只有用户点击「同步真实群组」按钮才调 POST（sync）实时请求 Telegram
 *   （getUpdates + 数据库关联 + getChat 三源合并），绝不默认自动同步。
 */

export interface RealGroup {
  chatId: string;
  chatTitle: string;
  /** updates=getUpdates 新发现；getchat=已关联群组经 getChat 验证仍在群内；cache=数据库已登记（未实时校验） */
  source: "updates" | "getchat" | "cache";
  /** 本次同步新登记（此前数据库中不存在） */
  isNew: boolean;
}

export interface SyncNote {
  ok: boolean;
  text: string;
}

/** 安全解析响应 JSON：空响应体 / 非 JSON（如 500 错误页）不再抛 "Unexpected end of JSON input" */
async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const text = await response.text();
    if (!text.trim()) return null;
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function mapGroups(
  raw: { chat_id: string; chat_title: string; source: string; is_new: boolean }[] | undefined,
): RealGroup[] {
  return (raw ?? []).map((group) => ({
    chatId: group.chat_id,
    chatTitle: group.chat_title,
    source:
      group.source === "updates" ? "updates" : group.source === "getchat" ? "getchat" : "cache",
    isNew: group.is_new === true,
  }));
}

export function useRealGroups(options: { botId: string | null }) {
  const { botId } = options;
  const [groups, setGroups] = useState<RealGroup[]>([]);
  /** 读取数据库已登记群组中（GET，不请求 Telegram） */
  const [loading, setLoading] = useState(false);
  /** 手动同步进行中（POST，请求 Telegram） */
  const [syncing, setSyncing] = useState(false);
  const [note, setNote] = useState<SyncNote | null>(null);

  /** 读取该机器人已登记的群组（数据库缓存，零 Telegram 消耗） */
  const loadCached = useCallback(async (): Promise<void> => {
    if (!botId) {
      setGroups([]);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(
        `/api/admin/telegram/real-groups?bot_id=${encodeURIComponent(botId)}`,
      );
      const payload = await readJson(response);
      if (payload && payload.ok === true && payload.data) {
        const data = payload.data as { groups?: { chat_id: string; chat_title: string; source: string; is_new: boolean }[] };
        setGroups(mapGroups(data.groups));
      } else {
        setGroups([]);
        if (payload && typeof payload.error === "string") {
          setNote({ ok: false, text: payload.error });
        }
      }
    } catch {
      setGroups([]);
    } finally {
      setLoading(false);
    }
  }, [botId]);

  /** 手动同步（仅由用户点击「同步真实群组」按钮触发） */
  const sync = useCallback(async (): Promise<RealGroup[] | null> => {
    if (!botId) return null;
    setSyncing(true);
    setNote(null);
    try {
      const response = await fetch("/api/admin/telegram/real-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bot_id: botId }),
      });
      const payload = await readJson(response);
      if (!payload) {
        setNote({
          ok: false,
          text: `服务返回异常（HTTP ${response.status}），请查看服务端日志后重试`,
        });
        return null;
      }
      if (payload.ok !== true || !payload.data) {
        setNote({
          ok: false,
          text:
            (typeof payload.error === "string" && payload.error) ||
            `同步失败（HTTP ${response.status}）`,
        });
        return null;
      }
      const data = payload.data as {
        bot_username: string | null;
        groups: { chat_id: string; chat_title: string; source: string; is_new: boolean }[];
        note: string | null;
      };
      const synced = mapGroups(data.groups);
      setGroups(synced);
      setNote({
        ok: true,
        text:
          data.note ??
          `已同步 ${synced.length} 个真实群组（新增 ${synced.filter((group) => group.isNew).length} 个）`,
      });
      return synced;
    } catch (error) {
      setNote({ ok: false, text: error instanceof Error ? error.message : "同步失败" });
      return null;
    } finally {
      setSyncing(false);
    }
  }, [botId]);

  // 切换机器人时重新读取该机器人已登记的群组（只读数据库，不请求 Telegram）
  useEffect(() => {
    setNote(null);
    void loadCached();
  }, [loadCached]);

  return { groups, loading, syncing, note, sync, setGroups, setNote, reload: loadCached };
}
