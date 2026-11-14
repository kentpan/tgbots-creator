import { Menu } from "@grammyjs/menu";
import type { Context } from "grammy";
import { getGlobalStats } from "@/database/operations";
import { config } from "@/config/settings";
import { isAdmin } from "./filters";
import { DEFAULT_BOT_HELP_MARKDOWN_V2 } from "@/services/bot-messages";

function formatPercent(rate: number): string {
  return `${rate.toFixed(1)}%`;
}

function sendHelp(ctx: Context): Promise<unknown> {
  return ctx.editMessageText(DEFAULT_BOT_HELP_MARKDOWN_V2, {
    parse_mode: "MarkdownV2",
    link_preview_options: { is_disabled: true },
    reply_markup: mainMenu,
  });
}

export function sendApiInfo(ctx: Context): Promise<unknown> {
  const apiConfig = config.api;
  let apiText: string;
  if (apiConfig.enable) {
    apiText =
      "🔌 *API 状态：已启用*\n\n" +
      "🌐 *服务器地址：*\n" +
      `\`${apiConfig.baseUrl}\`\n\n` +
      "🔑 *API Key：*\n" +
      `\`${apiConfig.apiKey}\`\n\n` +
      "⚠️ *注意：请妥善保管您的 API Key*";
  } else {
    apiText =
      "🔌 *API 状态：未启用*\n\n" +
      "请在配置文件中设置 `api.enable = true` 来启用 API 功能";
  }
  return ctx.reply(apiText, { parse_mode: "MarkdownV2" });
}

export const mainMenu = new Menu<Context>("tguard-main-menu")
  .text("📊 统计信息", async (ctx) => {
    await ctx.reply("📊 *TGuard 统计信息*\n\n点击下方按钮查看实时统计数据，数据会随刷新按钮实时更新。", {
      parse_mode: "MarkdownV2",
      reply_markup: statsMenu,
    });
  })
  .text("❓ 帮助", async (ctx) => {
    await sendHelp(ctx);
  })
  .row()
  .dynamic((ctx, range) => {
    if (isAdmin(ctx.from?.id)) {
      range
        .text("🔌 API 信息", async (ctx) => {
          await sendApiInfo(ctx);
        })
        .row();
    }
  })
  .text("❌ 关闭菜单", async (ctx) => {
    await ctx.reply("菜单已关闭。随时发送 /start 重新打开。");
    await ctx.menu.close();
  });

export const statsMenu = new Menu<Context>("tguard-stats-menu")
  .dynamic(async (_ctx, range) => {
    const stats = await getGlobalStats();
    if (!stats) {
      range
        .text("❌ 无法获取统计数据", async (ctx) => {
          await ctx.answerCallbackQuery({ text: "请检查数据库连接状态" });
        })
        .row();
      return;
    }
    range
      .text(
        `📈 总验证请求：${stats.total_requests}`,
        async (ctx) => {
          await ctx.answerCallbackQuery({ text: `总验证请求：${stats.total_requests}` });
        },
      )
      .row()
      .text(
        `✅ 已通过：${stats.approved}（${formatPercent(stats.approval_rate)}）`,
        async (ctx) => {
          await ctx.answerCallbackQuery({ text: `通过率：${formatPercent(stats.approval_rate)}` });
        },
      )
      .row()
      .text(
        `⛔ 已拒绝：${stats.rejected}　⏳ 待处理：${stats.pending}`,
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: `已拒绝：${stats.rejected}，待处理：${stats.pending}`,
          });
        },
      )
      .row()
      .text(
        `📅 今日请求：${stats.today_total}　今日通过：${stats.today_approved}`,
        async (ctx) => {
          await ctx.answerCallbackQuery({
            text: `今日通过率：${formatPercent(stats.today_approval_rate)}`,
          });
        },
      )
      .row();
  })
  .text("🔄 刷新", async (ctx) => {
    await ctx.menu.update();
  })
  .text("⬅️ 返回", async (ctx) => {
    await ctx.menu.back();
  })
  .row()
  .text("❌ 关闭菜单", async (ctx) => {
    await ctx.reply("菜单已关闭。随时发送 /start 重新打开。");
    await ctx.menu.close();
  });

mainMenu.register(statsMenu);
