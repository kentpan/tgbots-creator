import {
  getGroupBotAdminByBotAndChat,
  getGroupSettings,
  listBots,
  upsertGroupBotAdmin,
  upsertGroupSettings,
} from "@/database/operations";

/**
 * 进程内已登记聊天缓存：群消息高频到达时避免每条消息都打一次数据库。
 * 仅做去重（同进程同 chat 只登记一次），进程重启后首条消息会重新校准群名。
 */
const registeredChatKeys = new Set<string>();

/**
 * 幂等登记（带进程内去重）：供群消息等高频事件调用。
 * 返回 true 表示本次确实执行了登记/刷新，false 表示本进程已处理过该聊天。
 */
export async function ensureChatRegistered(input: {
  chatId: bigint;
  chatTitle: string | null;
  botToken?: string;
}): Promise<boolean> {
  const key = `${input.botToken ?? "*"}:${input.chatId}`;
  if (registeredChatKeys.has(key)) return false;
  registeredChatKeys.add(key);
  try {
    await registerTelegramChat(input);
    return true;
  } catch (error) {
    registeredChatKeys.delete(key);
    throw error;
  }
}

/**
 * 真实群组登记（机器人通过 Token 实际遇到的群组）。
 *
 * 登记原则：只补充 chat_id / chat_title，绝不覆盖群组已有的验证配置
 * （method / method_id / 文案 / 超时等全部原样回传，避免 upsert 默认值冲掉 code_api 绑定）。
 *
 * 触发来源：
 * 1. bot 运行时 my_chat_member 事件（机器人被加入/移出群组）
 * 2. bot 运行时 chat_join_request 事件（收到真实加群申请）
 * 3. 管理后台「机器人测试」页「同步真实群组」按钮（getUpdates 拉取后逐个登记）
 */
export async function registerTelegramChat(input: {
  chatId: bigint;
  chatTitle: string | null;
  /** 登记时用于关联机器人（该 Token 下的全部机器人条目都会建立链接） */
  botToken?: string;
}): Promise<{ isNew: boolean }> {
  // v2.0.6 D1 写额度优化（写放大 + 缓存失效死循环治理）：
  // Workers isolate 空闲 ~30s 回收 → registeredChatKeys 清空 → 每次冷启动
  // 都执行 upsertGroupSettings（写）+ invalidateCache（清群设置缓存），
  // 导致「下一条消息缓存必 miss → SELECT * FROM group_settings 全表」的
  // 死循环放大（读写双向烧额度）。现改为无变化跳过写：
  // - 已有配置且群名未变 → 跳过 upsertGroupSettings（配置列由 existing 原样回传，
  //   本来就是 no-op，跳过不改变任何语义）；
  // - bot 绑定已存在且 active → 跳过 upsertGroupBotAdmin。
  const existing = await getGroupSettings(input.chatId);
  const titleUnchanged =
    (input.chatTitle ?? null) === (existing?.chatTitle ?? null);
  if (!existing || !titleUnchanged) {
    await upsertGroupSettings(input.chatId, {
      chatTitle: input.chatTitle ?? existing?.chatTitle ?? null,
      // v1.1.7：新登记群组默认 code_self（自动验证码：机器人私聊发码，
      // 用户回复输入验证码即自动审批 —— 与「一键部署」宣传的主流程一致）；
      // 已有配置的群组原样回传，绝不覆盖
      method: existing?.method ?? "code_self",
      methodId: existing?.methodId ?? null,
      timeoutSeconds: existing?.timeoutSeconds ?? 300,
      maxAttempts: existing?.maxAttempts ?? 3,
      promptText: existing?.promptText ?? "🔐 请回复本消息并输入验证码完成验证",
      successText: existing?.successText ?? "✅ 验证成功，欢迎加入！",
      failureText: existing?.failureText ?? "❌ 验证码错误，请重试。",
      enabled: existing?.enabled ?? true,
      privacyMode: existing?.privacyMode ?? true,
    });
  }
  // 注意：bot 绑定检查不随群设置写入跳过 —— 新增 bot 条目共用群组时
  // （群设置已存在但缺该 bot 的绑定），绑定仍需补齐；
  // getGroupBotAdminByBotAndChat 是 (bot_id, chat_id) 唯一索引点查，成本极低。

  if (input.botToken) {
    const bots = await listBots();
    for (const bot of bots.filter((item) => item.token === input.botToken)) {
      const binding = await getGroupBotAdminByBotAndChat(bot.id, input.chatId);
      if (binding && binding.status === "active") {
        continue;
      }
      await upsertGroupBotAdmin({
        botId: bot.id,
        chatId: input.chatId,
        rights: "{}",
        status: "active",
      });
    }
  }

  return { isNew: !existing };
}
