import { buildMenuKeyboard } from "@/services/bot-menu";
import { countMenuStats, parseBotMenuConfig } from "@/services/menu-config";

const legacyConfig = parseBotMenuConfig(
  JSON.stringify({
    rootId: "main",
    messageText: "📋 请选择：",
    pages: [
      {
        id: "main",
        title: "主菜单",
        rows: [
          {
            id: "r1",
            buttons: [
              { id: "b1", text: "查余额", action: { type: "reply", text: "余额 {{user_id}}" } },
              {
                id: "b2",
                text: "今日价格",
                action: {
                  type: "api",
                  api: {
                    method: "GET",
                    url: "https://httpbin.org/get",
                    headers: [{ key: "Authorization", value: "Bearer x" }],
                    body_template: "",
                    success_status: 200,
                    timeout_seconds: 5,
                    response_template: "价格：{{res.url}}",
                  },
                },
              },
              { id: "b3", text: "更多", action: { type: "submenu", target: "sub" } },
            ],
          },
          { id: "r2", buttons: [{ id: "b4", text: "打开官网", action: { type: "url", url: "https://telegram.org" } }] },
        ],
      },
      {
        id: "sub",
        title: "更多功能",
        rows: [
          { id: "r3", buttons: [{ id: "b5", text: "返回", action: { type: "back" } }] },
        ],
      },
    ],
  }),
);

async function main(): Promise<void> {
  const stats = countMenuStats(legacyConfig.root);
  console.log("迁移后按钮数:", stats.buttons, "子菜单数:", stats.submenus, "层级:", stats.depth);
  if (stats.buttons !== 5 || stats.submenus !== 1 || stats.depth !== 2) {
    console.error("FAIL: 旧配置迁移结果不符合预期（应为 5 按钮 / 1 子菜单 / 2 层）");
    process.exit(1);
  }
  const moreButton = legacyConfig.root.rows[0].buttons[2];
  if (!moreButton.submenu || moreButton.submenu.rows.length !== 1 || moreButton.submenu.rows[0].buttons[0].text !== "返回") {
    console.error("FAIL: 旧配置的 target 子面板未迁移为按钮内嵌子菜单");
    process.exit(1);
  }
  if (legacyConfig.content.type !== "text" || legacyConfig.content.text !== "📋 请选择：") {
    console.error("FAIL: 旧配置 messageText 未迁移为菜单消息内容");
    process.exit(1);
  }

  // v1.1.1 自研菜单引擎：普通 InlineKeyboardMarkup + 稳定回调数据 bm/<节点id>/<行>/<列>
  const keyboard = buildMenuKeyboard(legacyConfig);
  const rows = keyboard.inline_keyboard;

  console.log("键盘行数:", rows.length);
  console.log(
    "布局:",
    rows.map((row) => row.map((button) => button.text).join(" | ")),
  );
  const more = rows[0][2];
  console.log("更多按钮回调:", "callback_data" in more ? more.callback_data : "(无)");
  if (rows.length !== 2 || rows[0].length !== 3 || rows[1].length !== 1) {
    console.error("FAIL: 键盘布局不符合 3-1 结构");
    process.exit(1);
  }
  if (
    !("callback_data" in more) ||
    typeof more.callback_data !== "string" ||
    !more.callback_data.startsWith("bm/tg:root/0/2")
  ) {
    console.error("FAIL: 子菜单按钮回调数据未按 bm/<菜单id>/<行>/<列> 编码");
    process.exit(1);
  }
  const urlButton = rows[1][0];
  if (!("url" in urlButton) || urlButton.url !== "https://telegram.org") {
    console.error("FAIL: url 按钮未渲染为 InlineKeyboardButton.url");
    process.exit(1);
  }
  // 子菜单键盘：返回按钮应挂 bm/m:b3/... 回调（父节点 m:b3）
  const childKeyboard = buildMenuKeyboard(legacyConfig, "m:b3");
  const back = childKeyboard.inline_keyboard[0][0];
  if (
    !("callback_data" in back) ||
    typeof back.callback_data !== "string" ||
    !back.callback_data.startsWith("bm/m:b3/0/0")
  ) {
    console.error("FAIL: 子菜单返回按钮回调数据未编码父节点 m:b3");
    process.exit(1);
  }
  console.log("OK: buildMenuKeyboard 布局、旧配置迁移与稳定回调数据正确");
}

void main();
