// 诊断脚本：通过全局代理查询 Telegram 侧 webhook 权威状态（getMe + getWebhookInfo）
import { readFileSync } from "node:fs";

const settings = readFileSync(".env", "utf-8");
const db = await import("node:sqlite").then((m) => new m.DatabaseSync("prisma/bot-groups.db", { readOnly: true }));

const proxyRow = db.prepare("SELECT value FROM app_settings WHERE key='telegram.proxy_url'").get();
const proxyUrlStr = proxyRow?.value ?? "";
const u = new URL(proxyUrlStr);
const basic = Buffer.from(`${u.username}:${u.password}`).toString("base64");
const prefix = `${u.origin}${u.pathname}`;

const bots = db.prepare("SELECT id, name, username, token FROM bots WHERE id IN (4,5)").all();

for (const bot of bots) {
  console.log(`\n===== bot #${bot.id} ${bot.name} =====`);
  const call = async (method, body) => {
    const url = `${prefix}https://api.telegram.org/bot${bot.token}/${method}`;
    const res = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  };
  const me = await call("getMe");
  console.log("getMe:", JSON.stringify(me));
  const wh = await call("getWebhookInfo");
  console.log("getWebhookInfo:", JSON.stringify(wh, null, 1));
}
db.close();
