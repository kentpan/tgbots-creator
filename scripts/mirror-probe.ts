/**
 * 手动探测目标 bot：导出命令表/简介/可见键盘样本 JSON。
 * 用法: MIRROR_API_ID=... MIRROR_API_HASH=... MIRROR_SESSION_STRING=... \
 *        MIRROR_TARGET_BOT=@My_Telegram_RoBot npx tsx scripts/mirror-probe.ts [输出文件]
 */
import { writeFileSync } from "node:fs";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";

async function main(): Promise<void> {
  const apiId = Number(process.env.MIRROR_API_ID ?? "");
  const apiHash = (process.env.MIRROR_API_HASH ?? "").trim();
  const sessionString = (process.env.MIRROR_SESSION_STRING ?? "").trim();
  const targetBot = (process.env.MIRROR_TARGET_BOT ?? "").trim().replace(/^@/, "");
  if (!apiId || !apiHash || !sessionString || !targetBot) {
    console.error("缺少 MIRROR_API_ID / MIRROR_API_HASH / MIRROR_SESSION_STRING / MIRROR_TARGET_BOT");
    process.exit(1);
  }
  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.connect();
  const entity = await client.getEntity(targetBot);
  const full = await client.invoke(new Api.users.GetFullUser({ id: entity }));
  const botInfo = full.fullUser.botInfo;
  const profile = {
    username: targetBot,
    id: entity.id.toString(),
    title: (entity as { firstName?: string }).firstName ?? targetBot,
    description: (full.fullUser as { about?: string }).about ?? "",
    menuButtonText:
      (botInfo as unknown as { menuButton?: { text?: string } })?.menuButton?.text ?? null,
    commands: (botInfo?.commands ?? []).map((cmd) => ({
      command: cmd.command,
      description: cmd.description,
    })),
    probedAt: new Date().toISOString(),
    note: "协议上不存在全量枚举他人 bot 按钮的能力，本文件为可见快照，供 rewriteRules 维护",
  };
  const output = process.argv[2] ?? `mirror-probe-${targetBot}.json`;
  writeFileSync(output, JSON.stringify(profile, null, 2), "utf8");
  console.log(`探测完成 → ${output}`);
  console.log(JSON.stringify(profile, null, 2));
  await client.disconnect();
}

main().catch((error) => {
  console.error("mirror-probe 执行失败:", error);
  process.exit(1);
});
