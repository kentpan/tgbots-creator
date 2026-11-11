import {
  listBots,
  listBotCommands,
  listGroupSettings,
  listTgApiUnlocks,
  listVerificationMethods,
} from "@/database/operations";
import { formatBeijingDateTimeMinute } from "@/utils/datetime";
import { requirePermission } from "@/lib/auth";
import { parseTgApiBotConfig } from "@/services/tgapi-config";
import type { CommandLibraryItem } from "@/app/admin/bots/command-menu-dialog";
import { TgApiPageClient } from "./page-client";

/**
 * TGAPI申请 页面（v2.2.1 SSR/CSR 分层）：
 *
 * - SSR（本文件）只做数据层与鉴权：requirePermission + DB 读取（bots / 验证方式 /
 *   解锁用户），并把数据收敛为纯 JSON props —— 无任何网络探测（部署状态探测是
 *   逐 bot 调 Telegram getWebhookInfo 的跨网络往返，此前在 SSR 串行等待是
 *   /admin/tgapi?bot=5&edit=1 响应过慢的根因）。
 * - 视觉层全部由 page-client.tsx（CSR）渲染；部署状态由客户端挂载后经
 *   /api/admin/bot-deploy-status 异步拉取（探测期间展示「探测中…」骨架）。
 */

export const dynamic = "force-dynamic";

export default async function TgApiPage({
  searchParams,
}: {
  searchParams: Promise<{
    bot?: string;
    saved?: string;
    error?: string;
    deploy?: string;
    deploy_msg?: string;
    edit?: string;
  }>;
}) {
  await requirePermission("tgapi:view");
  const params = await searchParams;

  const [bots, methods, builtinCommands, customCommands, groups] = await Promise.all([
    listBots(),
    listVerificationMethods(),
    listBotCommands({ type: "builtin", enabledOnly: true }),
    listBotCommands({ type: "custom", enabledOnly: true }),
    listGroupSettings(),
  ]);
  const tgapiBots = bots.filter((bot) => parseTgApiBotConfig(bot.config).enabled);

  // v2.2.8：指令菜单配置模块的指令库（与机器人管理页同源同过滤规则）——
  // 本机器人可见的自定义指令 = 全局 + 群组私有 + 本机器人私有；其他机器人私有不可见
  const commandLibrary = [...builtinCommands.rows, ...customCommands.rows].map((row) => ({
    id: String(row.id),
    name: row.name,
    description: row.description,
    intro: row.intro,
    type: row.type,
    botId: row.botId === null ? null : String(row.botId),
    groupId: row.groupId === null ? null : String(row.groupId),
  }));
  const scopeLabelOf = (
    item: (typeof commandLibrary)[number],
    botName: string | null,
  ): string | undefined => {
    if (item.type !== "custom") return undefined;
    if (item.botId !== null) return `🤖 ${botName ?? "机器人"} 私有`;
    if (item.groupId !== null) {
      const title = groups.find((group) => String(group.chatId) === item.groupId)?.chatTitle;
      return `👥 群组私有${title ? `（${title}）` : ""}`;
    }
    return undefined;
  };
  const commandLibraries: Record<string, CommandLibraryItem[]> = {};
  for (const bot of tgapiBots) {
    commandLibraries[String(bot.id)] = commandLibrary
      .filter(
        (item) =>
          item.type === "builtin" || item.botId === null || item.botId === String(bot.id),
      )
      .map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        intro: item.intro,
        type: item.type,
        scopeLabel: scopeLabelOf(item, bot.name),
      }));
  }
  // 新增机器人弹窗（尚无 id）：全局可见指令 = 内置 + 全局/群组私有自定义
  const newBotLibrary: CommandLibraryItem[] = commandLibrary
    .filter((item) => item.type === "builtin" || item.botId === null)
    .map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      intro: item.intro,
      type: item.type,
      scopeLabel: scopeLabelOf(item, null),
    }));

  const selectedBotId = params.bot && /^\d+$/.test(params.bot) ? params.bot : null;
  const selectedBot = selectedBotId
    ? tgapiBots.find((bot) => String(bot.id) === selectedBotId) ?? null
    : null;
  const unlocks = selectedBot ? await listTgApiUnlocks(selectedBot.id) : [];

  return (
    <TgApiPageClient
      bots={tgapiBots.map((bot) => ({
        id: String(bot.id),
        name: bot.name,
        username: bot.username,
        enabled: bot.enabled,
        config: bot.config,
        menuConfig: bot.menuConfig,
      }))}
      methods={methods.map((method) => ({
        id: Number(method.id),
        name: method.name,
        enabled: method.enabled,
        type: method.type,
      }))}
      commandLibraries={commandLibraries}
      newBotLibrary={newBotLibrary}
      notices={{
        saved: params.saved,
        error: params.error,
        deploy: params.deploy,
        deployMsg: params.deploy_msg,
      }}
      editBotId={params.edit === "1" ? selectedBotId : null}
      unlockPanel={
        selectedBot
          ? {
              botId: String(selectedBot.id),
              botName: selectedBot.name,
              unlocks: unlocks.map((unlock) => ({
                id: String(unlock.id),
                userId: String(unlock.userId),
                username: unlock.username ?? null,
                mode: unlock.mode,
                time: formatBeijingDateTimeMinute(unlock.updatedTime),
              })),
            }
          : null
      }
    />
  );
}
