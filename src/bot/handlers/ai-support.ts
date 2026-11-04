import type { Bot } from "grammy";
import { aiChatCompletion, resolveAiSelection } from "@/services/ai-client";
import type { BotContext } from "../context";

/**
 * AI 客服中间件（v1.1.0）
 *
 * 把任意机器人变成 AI 客服：
 * - 模型来自「AI 配置」的下拉浮层（auto = 系统默认模型；或 provider:model 指定）
 * - 多轮上下文保存在 grammY session（支持 SQLite/D1/R2 外部存储）
 * - 触发范围：private（仅私聊）/ private_mention（私聊 + 群内 @机器人）/ all（全部消息）
 */

export interface AiSupportConfig {
  enabled?: boolean;
  /** "auto" 或 "<providerId>:<model>"（来自 AI 模型下拉浮层） */
  modelSelection?: string;
  systemPrompt?: string;
  scope?: "private" | "private_mention" | "all";
  /** session 中保留的最大历史轮数（每轮 user+assistant 两条） */
  maxHistory?: number;
}

export const DEFAULT_AI_SYSTEM_PROMPT =
  "你是 Telegram 群组的智能客服助手。请用用户使用的语言简洁、友好地回答问题；" +
  "遇到无法回答的问题时，礼貌地建议用户联系人工管理员。";

function extractMentionUsername(text: string, offset: number, length: number): string {
  return text.slice(offset, offset + length).slice(1).toLowerCase();
}

/** 判断当前消息是否应触发 AI 回复 */
export function shouldAiReply(ctx: {
  chat?: { type: string };
  message?: { text?: string; entities?: { type?: string; offset: number; length: number }[] };
  me?: { username?: string };
  from?: { is_bot?: boolean };
}, scope: NonNullable<AiSupportConfig["scope"]>): boolean {
  if (ctx.from?.is_bot) return false;
  const text = (ctx.message?.text ?? "").trim();
  if (!text || text.startsWith("/")) return false; // 指令交给指令处理器

  if (ctx.chat?.type === "private") return true;
  if (scope === "all") return true;
  if (scope === "private_mention") {
    const username = ctx.me?.username?.toLowerCase();
    if (!username) return false;
    return (ctx.message?.entities ?? []).some(
      (entity) =>
        entity.type === "mention" &&
        extractMentionUsername(ctx.message?.text ?? "", entity.offset, entity.length) === username,
    );
  }
  return false;
}

function stripMention(text: string, username?: string): string {
  if (!username) return text;
  return text
    .replace(new RegExp(`@${username}\\b`, "gi"), "")
    .trim();
}

export function registerAiSupport(bot: Bot<BotContext>, config: AiSupportConfig, botId?: bigint): void {
  if (!config.enabled) return;
  const scope = config.scope ?? "private_mention";
  const maxHistory = Math.min(20, Math.max(2, config.maxHistory ?? 4));
  const systemPrompt = config.systemPrompt?.trim() || DEFAULT_AI_SYSTEM_PROMPT;

  bot.on("message:text", async (ctx) => {
    if (!shouldAiReply(ctx, scope)) return;
    const rawText = (ctx.message?.text ?? "").trim();
    const text = stripMention(rawText, ctx.me?.username);
    if (!text) return;

    // 输入状态提示
    await ctx.replyWithChatAction("typing").catch(() => undefined);

    const history = (ctx.session.aiHistory ?? []).slice(-maxHistory * 2);
    const { providerId, model } = await resolveAiSelection(config.modelSelection ?? "auto");

    const result = await aiChatCompletion({
      providerId,
      model: model ?? undefined,
      scene: "customer-service",
      botId: botId ?? null,
      messages: [
        { role: "system", content: systemPrompt },
        ...history.map((item) => ({ role: item.role, content: item.content })),
        { role: "user", content: text },
      ],
      temperature: 0.7,
      timeoutMs: 45000,
    });

    if (!result.ok) {
      await ctx
        .reply(
          result.rateLimited
            ? `⏳ ${result.error}`
            : "🤖 AI 服务暂时不可用，请稍后再试或联系管理员。",
        )
        .catch(() => undefined);
      return;
    }

    // 更新多轮历史（session 自动持久化到配置的存储后端）
    const nextHistory = [
      ...history,
      { role: "user" as const, content: text },
      { role: "assistant" as const, content: result.content },
    ].slice(-maxHistory * 2);
    ctx.session.aiHistory = nextHistory;

    await ctx.reply(result.content).catch(() => undefined);
  });
}

/** 供管理端预览的说明文案 */
export const AI_SUPPORT_SCOPES: { value: NonNullable<AiSupportConfig["scope"]>; label: string; description: string }[] = [
  { value: "private", label: "仅私聊", description: "只在用户与机器人私聊时回复" },
  { value: "private_mention", label: "私聊 + 群内 @机器人", description: "群组中需要 @机器人 才会回复（推荐，避免刷屏）" },
  { value: "all", label: "全部消息", description: "私聊与群组的所有文本消息都回复（注意消耗）" },
];
