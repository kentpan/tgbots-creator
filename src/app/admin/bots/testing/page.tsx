import { headers } from "next/headers";
import { requirePermission } from "@/lib/auth";
import {
  listBots,
  listGroupSettings,
  listGroupBotAdmins,
  listVerificationMethods,
} from "@/database/operations";
import { listXianyuProducts } from "@/database/xianyu-operations";
import { listVerifyApiKeys } from "@/services/verify-codes";
import { parseBotMenuConfig } from "@/services/bot-menu";
import type { BotMenuConfig } from "@/services/menu-config";
import { TestingClient } from "./testing-client";

export const dynamic = "force-dynamic";

function maskToken(token: string): string {
  if (token.length <= 12) return token;
  return `${token.slice(0, 8)}••••${token.slice(-4)}`;
}

export default async function BotTestingPage() {
  await requirePermission("bots:view");

  const [bots, groups, methods, botAdmins, products, apiKeys, requestHeaders] = await Promise.all([
    listBots(),
    listGroupSettings(),
    listVerificationMethods(),
    listGroupBotAdmins(),
    listXianyuProducts(100),
    listVerifyApiKeys(),
    headers(),
  ]);

  const proto = requestHeaders.get("x-forwarded-proto") ?? "http";
  const host = requestHeaders.get("host") ?? "localhost:3000";
  const origin = `${proto}://${host}`;

  // 同 Token 的机器人条目归为一组（如「交付机器人」与「加群验证机器人」共用同一 Token），
  // 测试任一条目时均可使用该 Token 关联的全部群组。
  const relatedBotIds: Record<string, string[]> = {};
  for (const bot of bots) {
    relatedBotIds[String(bot.id)] = bots
      .filter((other) => other.token === bot.token)
      .map((other) => String(other.id));
  }

  const methodNameById = new Map<string, string>();
  for (const method of methods) {
    methodNameById.set(String(method.id), method.name);
  }

  const groupOptions = groups.map((group) => ({
    chatId: String(group.chatId),
    chatTitle: group.chatTitle ?? `群组 ${String(group.chatId)}`,
    enabled: group.enabled,
    method: group.method,
    methodId: group.methodId === null ? null : String(group.methodId),
    methodName:
      group.methodId === null ? null : methodNameById.get(String(group.methodId)) ?? null,
    timeoutSeconds: group.timeoutSeconds,
    maxAttempts: group.maxAttempts,
  }));

  const botGroupLinks = botAdmins.map((link) => ({
    botId: String(link.botId),
    chatId: String(link.chatId),
  }));

  const menuConfigs: Record<string, BotMenuConfig> = {};
  for (const bot of bots) {
    menuConfigs[String(bot.id)] = parseBotMenuConfig(bot.menuConfig);
  }

  return (
    <TestingClient
      bots={bots.map((bot) => ({
        id: String(bot.id),
        name: bot.name,
        username: bot.username,
        enabled: bot.enabled,
        tokenMasked: maskToken(bot.token),
      }))}
      relatedBotIds={relatedBotIds}
      botGroupLinks={botGroupLinks}
      groups={groupOptions}
      menuConfigs={menuConfigs}
      initialProducts={products.map((product) => ({
        id: String(product.id),
        externalId: product.externalId,
        title: product.title,
        price: product.price,
        description: product.description,
        imageUrl: product.imageUrl,
        detailJson: product.detailJson,
        sourceUrl: product.sourceUrl,
        rawJson: product.rawJson,
        createdTime: product.createdTime.toISOString(),
      }))}
      origin={origin}
      demoApiKey={apiKeys[0] ?? ""}
    />
  );
}
