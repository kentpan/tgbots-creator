import { Bot } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import type { BotRow } from "@/database/operations";
import { telegramBotClientOptions } from "@/lib/telegram/transport";
import type { BotContext } from "@/bot/context";
import { createDedupe } from "./dedupe";
import { collectUpstreamMedia, MediaTooLargeError, recordOversizeMediaJob, upstreamMediaFromContext } from "./media";
import { resolveRelay, withRelayFailover } from "./relay";
import { getMirrorCallback, hasApprovedVerification, logMirrorEvent } from "./store";
import { parseMirrorConfig, resolveMirrorConfig, type MirrorConfig } from "./types";

const DEGRADE_REPLY = "⛔ 服务维护中，请稍后再试。";
const OVERSIZE_REPLY =
  "⚠️ 文件过大无法镜像（Bot API 下载上限 20MB），请压缩后重试或改用链接分享。";
const VERIFY_CHECK_ACTION = "mvv:check";

/** 验证绑定模式引导：绑定验证机器人未就绪时给出明确提示（绝不静默丢弃） */
async function sendVerifyGuide(
  ctx: import("grammy").Context,
  verifyBotId: number,
  userId: number,
): Promise<void> {
  const { getBot } = await import("@/database/operations");
  const { memoTtl } = await import("@/database/bindings");
  const botRow = await memoTtl(`mirror:verifybot:${verifyBotId}`, 60_000, () =>
    getBot(BigInt(verifyBotId)),
  );
  const username = botRow?.username;
  if (!username) {
    await ctx.reply(
      "⚠️ 绑定的验证机器人尚未同步用户名（需先启用该机器人并同步一次），请联系管理员。",
    );
    console.error(`[mirror] verify_bot 模式绑定机器人不可用（id=${verifyBotId}，username 缺失）`);
    return;
  }
  await ctx.reply(
    "🔒 首次使用请先完成人机验证。\n与加群验证共用同一套记录，验证一次即可通行：",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🛡️ 去完成验证", url: `https://t.me/${username}?start=mirror_verify` }],
          [{ text: "✅ 我已完成验证", callback_data: VERIFY_CHECK_ACTION }],
        ],
      },
    },
  );
  await logMirrorEvent({
    userId,
    direction: "inbound",
    event: "verify_required",
    payload: { verifyBotId },
  });
}

/**
 * 镜像壳 bot 装配（平面无关）：
 * - update_id 幂等（KV/内存自动选择）
 * - allowedUserIds 白名单（非名单用户静默忽略，防探测）
 * - 文本/命令原样透传（/start payload 无需预知命令表）
 * - 上行媒体 L1（≤20MB）收集后经中继转发
 * - callback_query 查 mirror_callbacks → relay.click 同步代点
 * - 无可用中继 → 受控降级（回复维护中 + mirror_logs 留痕），不崩不静默
 */
export async function createMirrorBot(row: BotRow, mirrorCfg: MirrorConfig): Promise<Bot<BotContext>> {
  const cfg = resolveMirrorConfig(mirrorCfg);
  const bot: Bot<BotContext> = new Bot(row.token, telegramBotClientOptions());
  bot.api.config.use(autoRetry({ maxRetryAttempts: 2, maxDelaySeconds: 5 }));
  bot.api.config.use(apiThrottler());

  const dedupe = createDedupe();

  bot.use(async (ctx, next) => {
    const updateId = ctx.update.update_id;
    const first = await dedupe.firstSeen(String(updateId));
    if (!first) {
      await logMirrorEvent({
        userId: ctx.from?.id ?? null,
        direction: "inbound",
        event: "duplicate_update",
        payload: { updateId },
      });
      return;
    }
    await next();
  });

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    // 白名单模式（显式配置 allowedUserIds）：保持原有防探测行为
    if (cfg.allowedUserIds.length > 0) {
      if (userId !== undefined && cfg.allowedUserIds.includes(userId)) {
        await next();
        return;
      }
      if (userId !== undefined) {
        console.warn(`[mirror] 非白名单用户访问已忽略（userId=${userId}）`);
        await logMirrorEvent({
          userId,
          direction: "inbound",
          event: "whitelist_rejected",
          payload: { targetBot: cfg.targetBot },
        });
      }
      return;
    }
    // 验证绑定模式：私聊用户须曾通过本系统加群验证（join_requests approved），
    // 与加群验证机器人共用验证记录 —— 用户不会被要求重复输第二次验证码
    if (cfg.accessMode === "verify_bot" && cfg.verifyBotId && ctx.chat?.type === "private") {
      if (userId === undefined) return;
      if (await hasApprovedVerification(userId)) {
        await next();
        return;
      }
      await sendVerifyGuide(ctx, cfg.verifyBotId, userId);
      return;
    }
    await next();
  });

  bot.on("message", async (ctx) => {
    if (ctx.chat?.type !== "private") return;
    const userId = ctx.from.id;
    const chatId = ctx.chat.id;
    const media = upstreamMediaFromContext(ctx);
    try {
      if (media) {
        const payload = await collectUpstreamMedia(ctx.api, row.token, media, cfg.mediaInlineMaxMb);
        await withRelayFailover(
          mirrorCfg,
          (relay) => relay.sendMedia(chatId, userId, payload),
          { userId, direction: "inbound", event: "upstream_media" },
        );
      } else if (ctx.message?.text) {
        const text = ctx.message.text;
        await withRelayFailover(
          mirrorCfg,
          (relay) => relay.send(chatId, userId, text),
          { userId, direction: "inbound", event: "upstream_text" },
        );
      } else {
        await ctx.reply("⚠️ 暂不支持镜像此类型的消息，请发送文本或媒体文件。");
      }
      await logMirrorEvent({ userId, direction: "inbound", event: "relayed", payload: { targetBot: cfg.targetBot } });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("MIRROR_RELAY_DEGRADED")) {
        await ctx.reply(DEGRADE_REPLY);
        return;
      }
      if (error instanceof MediaTooLargeError) {
        await recordOversizeMediaJob({ userId, proxyChatId: chatId, kind: media!.candidate.kind });
        await ctx.reply(OVERSIZE_REPLY);
        return;
      }
      console.error(`[mirror] 上行处理失败（bot=#${row.id} userId=${userId}）:`, error);
      await logMirrorEvent({
        userId,
        direction: "error",
        event: "upstream_failed",
        payload: { error: error instanceof Error ? error.message : String(error) },
      });
      await ctx.reply("⚠️ 消息转发失败，请稍后重试。").catch((replyError: unknown) => {
        console.error("[mirror] 降级回复发送失败:", replyError);
      });
    }
  });

  bot.on("callback_query:data", async (ctx) => {
    const userId = ctx.from.id;
    // 验证绑定模式：「我已完成验证」回执 —— 复查 approved 记录
    if (ctx.callbackQuery.data === VERIFY_CHECK_ACTION) {
      const approved = await hasApprovedVerification(userId).catch((error: unknown) => {
        console.error(`[mirror] 验证记录复查失败（userId=${userId}）:`, error);
        return false;
      });
      if (approved) {
        await ctx
          .answerCallbackQuery({ text: "✅ 验证已通过，现在可以正常使用了" })
          .catch((error: unknown) => {
            console.error("[mirror] answerCallbackQuery(验证通过) 失败:", error);
          });
      } else {
        await ctx
          .answerCallbackQuery({ text: "尚未查到验证记录，请先完成加群验证再回来确认" })
          .catch((error: unknown) => {
            console.error("[mirror] answerCallbackQuery(未验证) 失败:", error);
          });
      }
      return;
    }
    const proxyKey = ctx.callbackQuery.data;
    const record = await getMirrorCallback(proxyKey);
    if (!record || (record.staleAt !== null && record.staleAt < Date.now())) {
      await ctx.answerCallbackQuery({ text: "按钮已过期" }).catch((error: unknown) => {
        console.error("[mirror] answerCallbackQuery(过期) 失败:", error);
      });
      return;
    }
    const buttonText = record.buttonText ?? "";
    try {
      const answer = await withRelayFailover(
        mirrorCfg,
        (relay) => relay.click(record.targetMsgId, buttonText),
        { userId, direction: "click", event: "callback_click" },
      );
      if (answer?.message) {
        await ctx.answerCallbackQuery({ text: answer.message, show_alert: answer.alert === true });
      } else {
        await ctx.answerCallbackQuery();
      }
      await logMirrorEvent({
        userId,
        direction: "click",
        event: "clicked",
        payload: { targetMsgId: record.targetMsgId, buttonText },
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("MIRROR_RELAY_DEGRADED")) {
        await ctx.answerCallbackQuery({ text: "服务维护中，请稍后再试" }).catch((cbError: unknown) => {
          console.error("[mirror] answerCallbackQuery(降级) 失败:", cbError);
        });
        return;
      }
      console.error(`[mirror] 回调代点失败（bot=#${row.id} key=${proxyKey}）:`, error);
      await ctx.answerCallbackQuery({ text: "操作失败，请重试" }).catch((cbError: unknown) => {
        console.error("[mirror] answerCallbackQuery(失败) 出错:", cbError);
      });
      await logMirrorEvent({
        userId,
        direction: "error",
        event: "click_failed",
        payload: { proxyKey, error: error instanceof Error ? error.message : String(error) },
      });
    }
  });

  bot.catch((error) => {
    console.error(`Mirror bot #${row.id} update error:`, error.error);
  });

  return bot;
}

export { parseMirrorConfig, resolveMirrorConfig } from "./types";
export { resolveRelay } from "./relay";
