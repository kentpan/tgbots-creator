/**
 * 镜像机器人纯函数回归：sanitize（文本/URL 清洗）、keyboard（键盘重建/callback key）。
 * 运行: npm run test:mirror
 */
import { randomBytes } from "node:crypto";
import { buildProxyInlineKeyboard, generateCallbackKey, type TlMarkup } from "../src/bot/mirror/keyboard";
import { rewriteTelegramLinks, sanitizeText, sanitizeUrl } from "../src/bot/mirror/sanitize";
import { parseMirrorConfig, resolveMirrorConfig } from "../src/bot/mirror/types";

let failed = 0;

function ok(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`✅ ${label}`);
  } else {
    failed += 1;
    console.error(`❌ ${label}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

const OPTS = { targetBot: "My_Telegram_RoBot", proxyBot: "My_Shell_Bot" };

// ============ sanitize ============

ok(
  "@提及重写",
  sanitizeText("联系 @My_Telegram_RoBot 获取帮助", OPTS) === "联系 @My_Shell_Bot 获取帮助",
  sanitizeText("联系 @My_Telegram_RoBot 获取帮助", OPTS),
);

ok(
  "深链重写保留 payload",
  sanitizeText("点这里 https://t.me/My_Telegram_RoBot?start=abc123", OPTS) ===
    "点这里 https://t.me/My_Shell_Bot?start=abc123",
);

ok(
  "裸链移除",
  sanitizeText("频道 t.me/My_Telegram_RoBot 看截图", OPTS) === "频道  看截图",
  sanitizeText("频道 t.me/My_Telegram_RoBot 看截图", OPTS),
);

ok(
  "词表替换",
  sanitizeText("My Telegram RoBot 为你服务", { ...OPTS, rewriteRules: { "My Telegram RoBot": "Mirror Bot" } }) ===
    "Mirror Bot 为你服务",
);

ok(
  "普通 t.me 链接不受影响",
  sanitizeText("加入群组 https://t.me/some_group", OPTS) === "加入群组 https://t.me/some_group",
);

ok(
  "rewriteTelegramLinks 深链",
  rewriteTelegramLinks("t.me/My_Telegram_RoBot?start=x", OPTS) === "t.me/My_Shell_Bot?start=x",
);

ok("sanitizeUrl 深链", sanitizeUrl("t.me/My_Telegram_RoBot?start=zz", OPTS) === "https://t.me/My_Shell_Bot?start=zz");
ok("sanitizeUrl 目标页删除", sanitizeUrl("https://t.me/My_Telegram_RoBot/screenshot", OPTS) === "");
ok("sanitizeUrl 外链保留", sanitizeUrl("https://example.com/a", OPTS) === "https://example.com/a");
ok("其他 bot 提及不误伤", sanitizeText("@Other_RoBot 你好", OPTS) === "@Other_RoBot 你好");

// ============ keyboard ============

const KEY = "a".repeat(32);
const markup: TlMarkup = {
  rows: [
    [
      { kind: "callback", text: "确认", data: new Uint8Array([1, 2, 3]) },
      { kind: "url", text: "官网", url: "https://t.me/My_Telegram_RoBot?start=9" },
      { kind: "web_app", text: "打开应用", url: "https://target.example.com/app" },
      { kind: "switch_inline", text: "内联", query: "q", samePeer: false },
    ],
  ],
};
const built = buildProxyInlineKeyboard(markup, {
  resolveCallbackKey: () => KEY,
  sanitizeUrl: (url) => sanitizeUrl(url, { ...OPTS, rewriteRules: {} }),
});
const row = built?.inline_keyboard[0] ?? [];
ok("callback 按钮换成 proxy_key", row[0]?.callback_data === KEY);
ok("url 按钮深链已重写", row[1]?.url === "https://t.me/My_Shell_Bot?start=9", row[1]);
ok("web_app 降级为 url 按钮", Boolean(row[2]?.url) && !row[2]?.web_app);
ok("switch_inline 被移除", row.length === 3, row.length);

const empty = buildProxyInlineKeyboard({ rows: [[{ kind: "unsupported", text: "?" }]] }, {
  resolveCallbackKey: () => KEY,
  sanitizeUrl: (u) => u,
});
ok("全不支持按钮 → 无键盘", empty === undefined);

ok("callback key 32 hex", /^[0-9a-f]{32}$/.test(generateCallbackKey((size) => randomBytes(size))));

// ============ config ============

const parsed = parseMirrorConfig(
  JSON.stringify({ my_name: "x", mirror: { targetBot: "@My_Telegram_RoBot", allowedUserIds: [1, 2] } }),
);
ok("mirror 段解析（原文保留 @，resolve 时规范化）", parsed?.targetBot === "@My_Telegram_RoBot", parsed?.targetBot);
ok("无 mirror 段返回 null", parseMirrorConfig(JSON.stringify({ my_name: "x" })) === null);
const resolved = resolveMirrorConfig({ targetBot: "@My_Telegram_RoBot" });
ok(
  "缺省值展开",
  resolved.targetBot === "My_Telegram_RoBot" &&
    resolved.relayMode === "auto" &&
    resolved.serializeMode === "global" &&
    resolved.actionTimeoutSeconds === 60 &&
    resolved.mediaInlineMaxMb === 20 &&
    resolved.syncCommands === true,
);
ok(
  "超限超时收敛",
  resolveMirrorConfig({ targetBot: "x", actionTimeoutSeconds: 9999 }).actionTimeoutSeconds === 300,
);

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
