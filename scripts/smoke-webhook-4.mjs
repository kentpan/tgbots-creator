// 模拟 Telegram 推送私聊 /start 到本地 webhook 路由（验证密钥+实例处理全链路）
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("prisma/bot-groups.db", { readOnly: true });
const bot = db.prepare("SELECT id, token, username FROM bots WHERE id=4").get();
db.close();

// botWebhookSecret 与 src/lib/telegram/runtime-mode.ts 同算法（FNV-1a x2 派生）
function botWebhookSecret(botId, token) {
  const input = `tguard:${botId}:${token}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    h1 = (h1 ^ code) >>> 0;
    h1 = (h1 * 0x01000193) >>> 0;
    h2 = (h2 + code * (i + 7)) >>> 0;
    h2 = (h2 ^ (h2 << 13)) >>> 0;
  }
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghijkmnpqrstuvwxyz";
  let secret = "";
  let mixed = (h1 ^ h2) >>> 0;
  for (let i = 0; i < 24; i++) {
    secret += alphabet[mixed % alphabet.length];
    mixed = (mixed * 1664525 + 1013904223 + i) >>> 0;
  }
  return secret;
}

const secret = botWebhookSecret(String(bot.id), bot.token);
const update = {
  update_id: Date.now(),
  message: {
    message_id: Math.floor(Date.now() / 1000),
    from: { id: 900000001, is_bot: false, first_name: "LocalSmoke", username: "localsmoke_test", language_code: "zh-hans" },
    chat: { id: 900000001, first_name: "LocalSmoke", username: "localsmoke_test", type: "private" },
    date: Math.floor(Date.now() / 1000),
    text: "/start",
    entities: [{ offset: 0, length: 6, type: "bot_command" }],
  },
};

const res = await fetch(`http://localhost:3000/api/telegram/webhook/${bot.id}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": secret },
  body: JSON.stringify(update),
});
console.log("HTTP", res.status, await res.text());

// 反向验证：错误密钥必须被 401 拒收
const bad = await fetch(`http://localhost:3000/api/telegram/webhook/${bot.id}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": "WRONG-SECRET-0000000000000000000000" },
  body: JSON.stringify(update),
});
console.log("错误密钥反验：HTTP", bad.status, "(期望 401)");
