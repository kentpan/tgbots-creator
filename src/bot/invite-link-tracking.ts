import type { Bot, Context } from "grammy";
import type { ChatInviteLink } from "grammy/types";
import { listBots, upsertInviteLink } from "@/database/operations";

/**
 * 邀请链接台账（v2.1.2）：Bot API 没有列出「机器人创建的全部邀请链接」的方法
 * （createChatInviteLink / editChatInviteLink / revokeChatInviteLink 都只能操作单条），
 * 历史上验证超时补发、重新申请等路径创建的链接从未落库，管理后台无从查看也无法撤销，
 * 用户手里积累的链接成了「幽灵链接」。
 *
 * 本模块用 grammY API transformer 统一拦截所有 createChatInviteLink 调用
 * （部署管道 / 验证超时补发 / 验证失败重试 / 管理动作全部覆盖），创建成功后
 * 把链接异步落库到 invite_links 台账。台账记录绝不阻塞/影响业务主链路：
 * 落库失败仅 console.warn（链接本身已创建成功，Telegram 侧真实有效）。
 */

/** 解析 createChatInviteLink payload 的 chat_id（number / string） */
function chatIdFromPayload(payload: unknown): bigint | null {
  if (!payload || typeof payload !== "object") return null;
  const chatId = (payload as { chat_id?: unknown }).chat_id;
  if (typeof chatId === "number" && Number.isFinite(chatId)) return BigInt(Math.trunc(chatId));
  if (typeof chatId === "string" && /^-?\d+$/.test(chatId.trim())) {
    try {
      return BigInt(chatId.trim());
    } catch {
      return null;
    }
  }
  return null;
}

function inviteLinkFields(result: ChatInviteLink | undefined): {
  link: string;
  name: string | null;
  createsJoinRequest: boolean;
} | null {
  if (!result || typeof result !== "object") return null;
  const link = (result as { invite_link?: unknown }).invite_link;
  if (typeof link !== "string" || !link.trim()) return null;
  return {
    link: link.trim(),
    name: typeof (result as { name?: unknown }).name === "string" ? (result as { name: string }).name : null,
    createsJoinRequest: (result as { creates_join_request?: unknown }).creates_join_request === true,
  };
}

/** token → bots 表条目 id（listBots 60s 缓存；同 token 多条目取第一条，Telegram 侧本就是同一个 bot） */
async function resolveBotIdByToken(token: string): Promise<bigint | null> {
  try {
    const bots = await listBots();
    const hit = bots.find((item) => item.token === token);
    return hit ? hit.id : null;
  } catch {
    return null;
  }
}

/**
 * 为 Bot 实例挂载邀请链接台账 transformer（幂等可重复调用）。
 * 所有运行时 bot（主 bot createBot / multi-runtime createMenuBot / admin botByToken）
 * 都应挂载，保证任何路径创建的链接都可追溯。
 */
export function registerInviteLinkTracking<TContext extends Context>(
  bot: Bot<TContext>,
  token: string,
): void {
  bot.api.config.use(async (prev, method, payload, signal) => {
    const result = await prev(method, payload, signal);
    if (method === "createChatInviteLink") {
      const chatId = chatIdFromPayload(payload);
      const fields = inviteLinkFields(result as unknown as ChatInviteLink | undefined);
      if (chatId !== null && fields) {
        try {
          const botId = await resolveBotIdByToken(token);
          await upsertInviteLink({
            botId,
            chatId,
            link: fields.link,
            name: fields.name,
            createsJoinRequest: fields.createsJoinRequest,
            source: "api",
          });
        } catch (error) {
          console.warn(
            `[invite-link-tracking] record failed (token=${token.slice(0, 8)}…, chat=${chatId}):`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    }
    return result;
  });
}
