"use client";

import { useCallback, useState } from "react";
import { opsFetch } from "@/lib/remote-ops";
import { SplitDeployButton } from "@/components/admin/split-deploy-button";

export function GroupDeployButton({
  chatId,
  fallbackDeployed,
  fallbackBusy,
  onDeployChat,
  showFlash,
}: {
  chatId: string;
  /** 当前选中机器人的部署状态（浮层未加载时的回退判定） */
  fallbackDeployed: boolean;
  fallbackBusy: boolean;
  /** 父组件单机器人部署（当前选中机器人，含迁移刷新等副作用） */
  onDeployChat: (chatId: string) => Promise<void>;
  showFlash: (ok: boolean, text: string) => void;
}) {
  const [bots, setBots] = useState<{ id: string; name: string; deployed: boolean }[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [mainBusy, setMainBusy] = useState(false);
  const [busyBotId, setBusyBotId] = useState<string | null>(null);

  const loadBots = useCallback(async (): Promise<void> => {
    try {
      const response = await opsFetch(
        `/api/admin/bots/testing/group-bots?chat_id=${encodeURIComponent(chatId)}`,
        { cache: "no-store" },
      );
      const payload = (await response.json()) as {
        ok: boolean;
        error?: string;
        data?: { items: { id: string; name: string; deployed: boolean }[] };
      };
      if (!payload.ok || !payload.data) {
        showFlash(false, payload.error ?? "读取群组机器人列表失败");
        return;
      }
      setBots(payload.data.items);
      setLoaded(true);
    } catch (error) {
      showFlash(false, error instanceof Error ? error.message : "读取群组机器人列表失败");
    }
  }, [chatId, showFlash]);

  const deployOne = useCallback(
    async (botId: string, botName: string): Promise<boolean> => {
      try {
        const response = await opsFetch("/api/admin/bots/testing/deploy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bot_id: botId, chat_id: chatId }),
        });
        const payload = (await response.json()) as { ok: boolean; error?: string; stage?: string; reused?: boolean };
        if (!payload.ok) {
          showFlash(false, `${botName}：${payload.error ?? "部署校验失败"}`);
          return false;
        }
        if (payload.stage === "deployed") {
          showFlash(true, `${botName}：${payload.reused ? "复用已生成的有效邀请链接" : "入群申请链接已生成并保存"}`);
          return true;
        }
        showFlash(false, `${botName}：部署校验未通过（${payload.stage ?? "未知阶段"}），请按部署面板指引操作`);
        return false;
      } catch (error) {
        showFlash(false, `${botName}：${error instanceof Error ? error.message : "部署失败"}`);
        return false;
      }
    },
    [chatId, showFlash],
  );

  const deployAll = useCallback(async (): Promise<void> => {
    if (mainBusy) return;
    setMainBusy(true);
    try {
      let list = bots;
      if (!loaded) {
        try {
          const response = await opsFetch(
            `/api/admin/bots/testing/group-bots?chat_id=${encodeURIComponent(chatId)}`,
            { cache: "no-store" },
          );
          const payload = (await response.json()) as {
            ok: boolean;
            data?: { items: { id: string; name: string; deployed: boolean }[] };
          };
          if (payload.ok && payload.data) {
            list = payload.data.items;
            setBots(list);
            setLoaded(true);
          }
        } catch {
          /* 加载失败时回退：部署当前选中机器人 */
        }
      }
      if (list.length === 0) {
        // 该群没有机器人管理员登记（如基础群未登记）：回退部署当前选中机器人
        await onDeployChat(chatId);
        return;
      }
      let okCount = 0;
      for (const bot of list) {
        setBusyBotId(bot.id);
        if (await deployOne(bot.id, bot.name)) okCount += 1;
      }
      setBusyBotId(null);
      showFlash(okCount === list.length, `部署完成：${okCount}/${list.length} 个机器人成功`);
      await loadBots();
    } finally {
      setMainBusy(false);
      setBusyBotId(null);
    }
  }, [bots, loaded, chatId, mainBusy, onDeployChat, deployOne, showFlash, loadBots]);

  const allDeployed = loaded && bots.length > 0 ? bots.every((bot) => bot.deployed) : fallbackDeployed;

  return (
    <SplitDeployButton
      mainLabel={allDeployed ? "重新部署所有机器人" : "一键部署所有机器人"}
      mainBusy={mainBusy || fallbackBusy}
      onMain={() => void deployAll()}
      items={bots.map((bot) => ({ id: bot.id, label: bot.name, deployed: bot.deployed }))}
      itemBusyId={busyBotId}
      onSelectItem={(botId) => {
        const bot = bots.find((entry) => entry.id === botId);
        setBusyBotId(botId);
        void deployOne(botId, bot?.name ?? `#${botId}`).then(() => {
          setBusyBotId(null);
          return loadBots();
        });
      }}
      onLoadItems={() => void loadBots()}
      emptyHint="该群还没有机器人管理员登记：先把机器人添加为群管理员并点部署"
    />
  );
}
