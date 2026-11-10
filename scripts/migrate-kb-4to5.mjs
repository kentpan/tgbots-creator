// 数据操作：#5「TGAPI申请」自定义键盘配置 → #4「Telegram API 申请助手」，然后删除 #5
// 事务内完成：复制 customKeyboard + interfaceMode=keyboard；删除 bots id=5 及关联行
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("prisma/bot-groups.db");

const b4 = db.prepare("SELECT config FROM bots WHERE id=4").get();
const b5 = db.prepare("SELECT config FROM bots WHERE id=5").get();
if (!b4 || !b5) {
  console.error("机器人 #4 或 #5 不存在，中止");
  process.exit(1);
}

const cfg4 = JSON.parse(b4.config);
const cfg5 = JSON.parse(b5.config);
const kb = cfg5.tgapi?.customKeyboard;
if (!kb || !kb.root?.rows?.length) {
  console.error("#5 config.tgapi.customKeyboard 为空或无按钮，中止");
  process.exit(1);
}

console.log(
  "#5 键盘：",
  kb.root.rows.map((r) => r.buttons.map((b) => b.text).join(" | ")).join("  //  "),
);

// 复制键盘配置 + 生效模式（v2.2.6 interfaceMode 解耦：keyboard = 自定义键盘生效）
cfg4.tgapi.customKeyboard = kb;
cfg4.tgapi.interfaceMode = "keyboard";

db.exec("BEGIN");
try {
  db.prepare("UPDATE bots SET config=?, updated_time=datetime('now','localtime') WHERE id=4").run(
    JSON.stringify(cfg4),
  );
  const links = db.prepare("DELETE FROM group_bot_admins WHERE bot_id=5").run();
  const cmds = db.prepare("DELETE FROM bot_commands WHERE bot_id=5").run();
  const users = db.prepare("DELETE FROM tgapi_bot_users WHERE bot_id=5").run();
  const unlocks = db.prepare("DELETE FROM tgapi_unlocks WHERE bot_id=5").run();
  const logs = db.prepare("DELETE FROM api_logs WHERE bot_id=5").run();
  db.prepare("DELETE FROM bots WHERE id=5").run();
  db.exec("COMMIT");
  console.log(
    `完成：#4 键盘已复制（interfaceMode=keyboard）；删除 #5：群组关联 ${links.changes}、指令 ${cmds.changes}、用户 ${users.changes}、解锁 ${unlocks.changes}、日志 ${logs.changes}、机器人记录 1`,
  );
} catch (error) {
  db.exec("ROLLBACK");
  console.error("事务失败已回滚:", error);
  process.exit(1);
}

// 验证
const v4 = JSON.parse(db.prepare("SELECT config FROM bots WHERE id=4").get().config).tgapi;
console.log("验证 #4：interfaceMode =", v4.interfaceMode, "| 键盘行数 =", v4.customKeyboard.root.rows.length);
console.log("验证 bots 表：", db.prepare("SELECT id, name, username FROM bots ORDER BY id").all());
db.close();
