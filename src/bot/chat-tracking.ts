import type { Bot } from "grammy";
import type { BotContext } from "./context";
import { ensureChatRegistered } from "@/services/chat-registry";

/**
 * 真实群组自动登记（v1.1.1 修复「获取不到已加入的群组」）：
 *
 * 此前只有主 bot（createBot）注册了 my_chat_member 登记逻辑，而「机器人管理」创建的
 * 机器人全部跑在 multi-runtime（createMenuBot）里 —— 被拉进群组后 Telegram 的
 * my_chat_member 更新被轮询消费却没有登记，管理后台永远看不到真实群组。
 *
 * 本模块为任意 Bot 实例统一挂载三类登记事件（幂等，全部走 chat-registry）：
 * 1. my_chat_member       —— 机器人被加入/移出群组、被提升/撤销管理员（最权威）
 * 2. chat_join_request    —— 收到真实加群申请（supergroup）
 * 3. message/channel_post —— 群内任何可见消息兜底登记（管理员 bot 收到全部消息；
 *    隐私模式 bot 也能收到指令/回复/服务消息），进程内去重，不会每条消息打库
 */
export function registerChatTracking(bot: Bot<BotContext>, token: string): void {
  // 【铁律】grammY 中间件语义：handler 不调 next() = 终结整条链。本模块注册在
  // 验证/指令/验证码输入等业务 handler 之前，三个登记 handler 必须在完成后
  // await next() 放行，否则后续所有 handler 全部静默失效（2026-11-03 抓到的
  // 「加群申请石沉大海/指令全部无响应」的总根因，v1.1.1 起即存在）。

  // 1) 机器人自身成员状态变化（被加入群组/设为管理员等）——最可靠的登记来源
  bot.on("my_chat_member", async (ctx, next) => {
    const chat = ctx.myChatMember.chat;
    if (chat.type === "group" || chat.type === "supergroup") {
      try {
        const changed = await ensureChatRegistered({
          chatId: BigInt(chat.id),
          chatTitle: chat.title ?? null,
          botToken: token,
        });
        if (changed) {
          console.log(
            `Registered real chat ${chat.id} (${chat.title ?? "unnamed"}) via my_chat_member`,
          );
        }
      } catch (error) {
        console.warn("Failed to register real chat from my_chat_member:", error);
      }
    }
    await next();
  });

  // 2) 真实加群申请到达即登记（supergroup；与验证流程解耦，验证由各运行时自行挂载）
  bot.on("chat_join_request", async (ctx, next) => {
    const chat = ctx.chatJoinRequest?.chat;
    if (chat && chat.type === "supergroup") {
      try {
        const changed = await ensureChatRegistered({
          chatId: BigInt(chat.id),
          chatTitle: chat.title ?? null,
          botToken: token,
        });
        if (changed) {
          console.log(
            `Registered real chat ${chat.id} (${chat.title ?? "unnamed"}) via join request`,
          );
        }
      } catch (error) {
        console.warn("Failed to register real chat from join request:", error);
      }
    }
    await next();
  });

  // 3) 群消息兜底登记（进程内去重）：把机器人拉进群后随便在群里发一条消息即可被发现
  bot.on(["message", "channel_post"], async (ctx, next) => {
    const chat = ctx.chat;
    if (chat && (chat.type === "group" || chat.type === "supergroup")) {
      try {
        await ensureChatRegistered({
          chatId: BigInt(chat.id),
          chatTitle: chat.title ?? null,
          botToken: token,
        });
      } catch {
        /* 消息链路上的登记失败静默（my_chat_member 仍是主通道） */
      }
    }
    await next();
  });
}
