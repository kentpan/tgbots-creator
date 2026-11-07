/**
 * 一次性交互登录：生成 userbot StringSession。
 * 用法: MIRROR_API_ID=... MIRROR_API_HASH=... npx tsx scripts/mirror-login.ts
 * 输出的 session 字符串注入 MIRROR_SESSION_STRING（仅存中继环境，不入库不进 git）。
 */
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";

async function main(): Promise<void> {
  const apiId = Number(process.env.MIRROR_API_ID ?? "");
  const apiHash = (process.env.MIRROR_API_HASH ?? "").trim();
  if (!apiId || !apiHash) {
    console.error("缺少 MIRROR_API_ID / MIRROR_API_HASH 环境变量（https://my.telegram.org 获取）");
    process.exit(1);
  }
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const storeSession = new StringSession("");
  const client = new TelegramClient(storeSession, apiId, apiHash, { connectionRetries: 5 });
  await client.start({
    phoneNumber: async () => rl.question("手机号（含国际区号，如 +8613...）: "),
    password: async () => rl.question("两步验证密码（未设置直接回车）: "),
    phoneCode: async () => rl.question("收到的验证码: "),
    onError: (error) => {
      console.error("登录失败:", error);
    },
  });
  console.log("\n登录成功。StringSession（保存到 MIRROR_SESSION_STRING，切勿泄露）:\n");
  console.log(client.session.save());
  await rl.close();
  await client.disconnect();
}

main().catch((error) => {
  console.error("mirror-login 执行失败:", error);
  process.exit(1);
});
