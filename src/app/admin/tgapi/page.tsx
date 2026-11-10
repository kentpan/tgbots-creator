import {
  listBots,
  listTgApiUnlocks,
  listVerificationMethods,
} from "@/database/operations";
import { formatBeijingDateTimeMinute } from "@/utils/datetime";
import { requirePermission } from "@/lib/auth";
import { parseTgApiBotConfig } from "@/services/tgapi-config";
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

  const [bots, methods] = await Promise.all([listBots(), listVerificationMethods()]);
  const tgapiBots = bots.filter((bot) => parseTgApiBotConfig(bot.config).enabled);

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
