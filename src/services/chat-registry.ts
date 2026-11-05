import {
  ensureGroupBotAdmin,
  getGroupSettings,
  listBots,
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
  const existing = await getGroupSettings(input.chatId);
  // 空字符串/纯空白视为「无群名」：upsertGroupSettings 的 COALESCE 只对 NULL 生效，
  // 传空串会把数据库里已有的真实群名覆盖掉
  const title = input.chatTitle?.trim() || existing?.chatTitle?.trim() || null;
  await upsertGroupSettings(input.chatId, {
    chatTitle: title,
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

  if (input.botToken) {
    const bots = await listBots();
    for (const bot of bots.filter((item) => item.token === input.botToken)) {
      // 只补建关联：rights 里存着一键部署状态（入群申请链接）与管理员权限快照，
      // 自动登记绝不能覆盖（否则每次群事件都清空部署状态）
      await ensureGroupBotAdmin({
        botId: bot.id,
        chatId: input.chatId,
        status: "active",
      });
    }
  }

  return { isNew: !existing };
}
