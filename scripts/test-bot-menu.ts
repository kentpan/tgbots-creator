import { buildBotMenu, validateMenuConfig } from "@/services/bot-menu";
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

  // v1.1.1 菜单引擎已切换为 grammY 官方 @grammyjs/menu（旧自研 buildMenuKeyboard
  // 已移除）：此处验证 ① 配置通过全量校验规则 ② 官方插件菜单实例树可正常构建
  const validation = validateMenuConfig(legacyConfig);
  if (!validation.ok) {
    console.error("FAIL: 菜单配置未通过校验:", validation.reason);
    process.exit(1);
  }
  const menu = buildBotMenu(legacyConfig);
  if (!menu) {
    console.error("FAIL: @grammyjs/menu 实例树构建失败");
    process.exit(1);
  }
  console.log("OK: 旧配置迁移、菜单配置校验与 @grammyjs/menu 实例树构建正确");
}

void main();
