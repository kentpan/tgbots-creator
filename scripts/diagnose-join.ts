/**
 * 加群验证链路诊断（纯 Bot API，无数据库依赖）：
 *   BOT_TOKEN=123:AAx CHAT_ID=-1001234567890 npx tsx scripts/diagnose-join.ts
 * 出站走 HTTPS_PROXY / HTTP_PROXY（沙盒/需代理网络下同样可用）。
 * 逐项检查：消费端（Webhook/轮询）→ 群类型 → 机器人管理员权限 → 结论。
 */
import { loadDotEnv } from "../src/lib/dotenv";

const API = "https://api.telegram.org";

async function outboundFetch(url: string, init?: RequestInit): Promise<Response> {
  const proxy = (process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy ?? "").trim();
  if (proxy) {
    const { ProxyAgent, fetch: undiciFetch } = await import("undici");
    return undiciFetch(url, { ...(init as object), dispatcher: new ProxyAgent(proxy) }) as unknown as Response;
  }
  return fetch(url, init);
}

async function call<T>(token: string, method: string, payload?: Record<string, unknown>): Promise<T> {
  const resp = await outboundFetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  const data = (await resp.json()) as { ok: boolean; result?: T; description?: string };
  if (!data.ok) throw new Error(`${method}: ${data.description ?? `HTTP ${resp.status}`}`);
  return data.result as T;
}

async function main(): Promise<void> {
  loadDotEnv();
  const token = (process.env.BOT_TOKEN ?? process.env.DIAG_BOT_TOKEN ?? "").trim();
  const chatId = Number((process.env.CHAT_ID ?? process.env.DIAG_CHAT_ID ?? "").trim());
  if (!token || !chatId) {
    console.error("用法: BOT_TOKEN=<机器人Token> CHAT_ID=<群组ID> npx tsx scripts/diagnose-join.ts");
    process.exit(1);
  }
  const problems: string[] = [];

  // ① 消费端：Webhook 状态（最常见断点）
  const hook = await call<{
    url: string;
    pending_update_count: number;
    last_error_message?: string;
    last_error_date?: number;
    ip_address?: string;
  }>(token, "getWebhookInfo");
  console.log("── ① 消费端（Webhook）──");
  console.log(`  URL: ${hook.url || "（未注册 Webhook）"}`);
  console.log(`  待处理更新: ${hook.pending_update_count}`);
  if (hook.last_error_message) {
    const when = hook.last_error_date ? new Date(hook.last_error_date * 1000).toLocaleString("zh-CN") : "";
    console.log(`  ⚠ 最近错误: ${hook.last_error_message} (${when})`);
    problems.push(`Webhook 持续报错: ${hook.last_error_message}`);
  }
  if (!hook.url) {
    console.log("  → 该机器人未注册 Webhook：如果本地 Node 服务没在跑轮询，就没有任何消费者，加群事件无人处理。");
    problems.push("无 Webhook 且本地轮询未运行 = 无消费者");
  } else if (hook.pending_update_count > 0 && hook.last_error_message) {
    problems.push(`有 ${hook.pending_update_count} 条更新积压且持续报错 — 服务端处理链路故障（如数据库超限），事件没有被消费`);
  }

  // ② 群类型：chat_join_request 仅超级群支持
  const chat = await call<{ id: number; type: string; title?: string }>(token, "getChat", { chat_id: chatId });
  console.log("── ② 群组 ──");
  console.log(`  ${chat.title ?? chatId} · 类型=${chat.type}`);
  if (chat.type !== "supergroup") {
    problems.push(
      `群类型是 ${chat.type}：入群申请（join request）仅超级群（supergroup）支持，普通群点链接直接进群，机器人收不到任何事件。请把群升级为超级群（群里发一条消息即自动升级/或将群设为公开后 Telegram 会自动转超级群）。`,
    );
  }

  // ③ 机器人在群内的身份与权限
  const me = await call<{ id: number; username?: string }>(token, "getMe");
  const member = await call<{ status: string; can_invite_users?: boolean; can_restrict_members?: boolean; can_delete_messages?: boolean }>(
    token,
    "getChatMember",
    { chat_id: chatId, user_id: me.id },
  );
  console.log("── ③ 机器人权限 ──");
  console.log(`  @${me.username ?? me.id} 状态=${member.status}`);
  if (member.status !== "administrator") {
    problems.push("机器人不是群管理员：无法生成/审批入群申请链接，也无法群内禁言发验证。");
  } else {
    if (member.can_invite_users !== true) problems.push("机器人缺少「邀请用户 via 链接」权限：无法生成入群申请链接。");
    if (member.can_restrict_members !== true) console.log("  ⓘ 无「封禁用户」权限（群内验证失败踢出不可用，但不影响入群反应）");
  }

  // ④ 结论
  console.log("── 结论 ──");
  if (problems.length === 0) {
    console.log("  ✅ 以上各项均正常。若加群仍无反应，请检查：");
    console.log("  1) 后台「群组管理」里该群是否已登记并启用验证（未配置时走私聊验证模式，去机器人私聊看有没有验证消息）");
    console.log("  2) 生成链接后是否重新部署（旧链接不是申请类型）");
    console.log("  3) 本地与线上是否同时运行同一 Token（互斥：只有一个消费者，看运行日志的「远程 Webhook 消费者」提示）");
  } else {
    for (const problem of problems) console.log(`  ❌ ${problem}`);
  }
}

main().catch((error) => {
  console.error("诊断执行失败:", error);
  process.exit(1);
});
