import { Api, Bot, Context } from "grammy";
import type { InlineKeyboardButton, InlineKeyboardMarkup } from "grammy/types";
import { Menu } from "@grammyjs/menu";
import type { BotContext } from "@/bot/context";
import {
  countMenuStats,
  executeMenuApi,
  isHttpUrl,
  MENU_MAX_BUTTONS_PER_ROW,
  MENU_MAX_BUTTONS_TOTAL,
  MENU_MAX_DEPTH,
  MENU_MAX_ROWS,
  normalizeReplyContent,
  renderMenuTemplate,
  varsFromContext,
  type BotMenuConfig,
  type MenuButton,
  type MenuMessageContent,
  type MenuNode,
} from "@/services/menu-config";

export * from "@/services/menu-config";

/**
 * 消息内嵌按钮菜单（v1.1.1）：100% 基于 grammY 官方菜单插件 @grammyjs/menu。
 *
 * 插件为 grammY 官方生产验证方案（https://grammy.dev/plugins/menu ，
 * GitHub grammyjs/menu，grammY 核心团队维护）：
 *
 * - 机器人运行时 installBotMenu → bot.use(menu)：callback_query 路由、子菜单
 *   导航（ctx.menu.nav/back）、过期键盘自动检测与恢复、自动应答 callback_query
 *   全部由官方插件中间件处理，不再有任何自研回调路由；
 * - 管理后台「同步到群组」在 update 管道之外直发消息，此时使用官方公开 API
 *   menu.render(ctx)（grammy.dev/ref/menu/menu 文档方法）把菜单渲染为普通
 *   InlineKeyboardMarkup —— 序列化仍由插件自身代码完成，键盘内回调数据与
 *   插件中间件的解码格式天然一致。
 *
 * 子菜单 id 采用结构性生成（父id.行.列），不含用户输入、不含 "/"，
 * 与插件 callback_data 的 "/" 分割格式完全兼容。
 */

/** 根菜单节点 id */
export const MENU_ROOT_ID = "tg:root";

/**
 * 官方 Menu 子类：render 在插件类型层声明为 protected（仅限类内渲染），
 * 本子类在同一继承体系内合法开放给管理后台的 update 管道外渲染使用。
 */
class TGuardMenu extends Menu<Context> {
  renderMarkup(ctx: Context): Promise<InlineKeyboardButton[][]> {
    return this.render(ctx);
  }
}

/** 子菜单节点 id：父id.行索引.列索引（结构性唯一，跨重启稳定） */
function childMenuId(parentId: string, rowIndex: number, colIndex: number): string {
  return `${parentId}.${rowIndex}.${colIndex}`;
}

function appendButton(menu: TGuardMenu, button: MenuButton, parentId: string): void {
  const action = button.action;
  switch (action.type) {
    case "url": {
      const url = action.url?.trim() ?? "";
      if (isHttpUrl(url)) {
        menu.url(button.text, url);
        return;
      }
      menu.text(button.text, (ctx) =>
        ctx.reply("⚠️ 该按钮链接地址不合法，请在管理后台菜单设计器中补全"),
      );
      return;
    }
    case "web_app": {
      const url = action.url?.trim() ?? "";
      if (isHttpUrl(url)) {
        menu.webApp(button.text, url);
        return;
      }
      menu.text(button.text, (ctx) =>
        ctx.reply("⚠️ 该按钮 Mini App 地址不合法，请在管理后台菜单设计器中补全"),
      );
      return;
    }
    case "switch_inline": {
      menu.switchInline(button.text, action.switch_query ?? "");
      return;
    }
    case "switch_inline_current": {
      menu.switchInlineCurrent(button.text, action.switch_query ?? "");
      return;
    }
    case "submenu": {
      // 完整子菜单在 buildNodeMenu 中统一处理（先加按钮、后 register，见其注释）
      if (!button.submenu) {
        menu.text(button.text, (ctx) => ctx.reply("⚠️ 该按钮指向的子菜单不存在"));
      }
      return;
    }
    case "back": {
      // 子菜单内：官方 back 导航到父菜单；根菜单没有父级，给出确定提示
      if (parentId !== MENU_ROOT_ID) {
        menu.back(button.text);
        return;
      }
      menu.text(button.text, (ctx) => ctx.reply("已在主菜单"));
      return;
    }
    case "api": {
      const apiConfig = action.api;
      if (!apiConfig) {
        menu.text(button.text, (ctx) => ctx.reply("⚠️ 该按钮还没有配置接口"));
        return;
      }
      menu.text(button.text, async (ctx) => {
        const result = await executeMenuApi(apiConfig, varsFromContext(ctx));
        await ctx.reply(result.ok ? result.text : `⚠️ ${result.text}`);
      });
      return;
    }
    case "reply":
    default: {
      menu.text(button.text, async (ctx) => {
        await sendContent(ctx, normalizeReplyContent(action));
      });
      return;
    }
  }
}

function buildNodeMenu(node: MenuNode, nodeId: string): TGuardMenu {
  const menu = new TGuardMenu(nodeId);
  const children: TGuardMenu[] = [];
  let firstRow = true;
  node.rows.forEach((row, rowIndex) => {
    if (!firstRow) menu.row();
    firstRow = false;
    row.buttons.forEach((button, colIndex) => {
      if (button.action.type === "submenu" && button.submenu) {
        // 官方插件顺序约束：register() 会 freeze 当前菜单（此后任何按钮都不能再加），
        // 因此必须先把本节点全部按钮（含 submenu 导航按钮）加完，最后统一 register 子菜单；
        // 子菜单内部同理递归构建完毕后才被 register
        const childId = childMenuId(nodeId, rowIndex, colIndex);
        children.push(buildNodeMenu(button.submenu, childId));
        menu.submenu(button.text, childId);
        return;
      }
      appendButton(menu, button, nodeId);
    });
  });
  if (children.length > 0) menu.register(children);
  return menu;
}

/** 由菜单配置构建官方 @grammyjs/menu 实例树（根 id 固定为 tg:root） */
export function buildBotMenu(config: BotMenuConfig): TGuardMenu {
  return buildNodeMenu(config.root, MENU_ROOT_ID);
}

/**
 * 在机器人实例上安装官方菜单插件（回调路由全部由插件处理）。
 * 每个机器人实例独立构建自己的 Menu 树，无共享状态。
 */
export function installBotMenu(bot: Bot<BotContext>, config: BotMenuConfig): TGuardMenu {
  const menu = buildBotMenu(config);
  bot.use(menu);
  return menu;
}

/**
 * 把菜单配置渲染为普通 InlineKeyboardMarkup（官方 menu.render(ctx)）。
 * 管理后台在 update 管道之外直发消息时使用；优先用运行实例已缓存的
 * botInfo，实例尚未初始化时补一次 getMe（真实的机器人身份）。
 *
 * v2.1.1 修复「同步失败：Bot information unavailable!」：grammY 的 bot.botInfo
 * 是 getter —— 实例未 init() 时访问直接抛错（而不是返回 undefined），
 * 旧写法 `bot.botInfo ?? (await bot.api.getMe())` 的兜底分支永远走不到。
 * 必须先用 isInited() 显式判定（与 webhook 路由同款），未初始化时走 getMe。
 */
export async function renderMenuMarkup(
  config: BotMenuConfig,
  bot: Bot<BotContext>,
): Promise<InlineKeyboardMarkup> {
  const menu = buildBotMenu(config);
  const me = bot.isInited() ? bot.botInfo : await bot.api.getMe();
  const ctx = new Context({ update_id: 0 }, bot.api, me);
  return { inline_keyboard: await menu.renderMarkup(ctx) };
}

async function sendContent(ctx: Context, content: MenuMessageContent): Promise<void> {
  if (!ctx.chat) return;
  const chatId = ctx.chat.id;
  if (content.type === "photo" && isHttpUrl(content.mediaUrl)) {
    await ctx.api.sendPhoto(chatId, content.mediaUrl, {
      caption: renderMenuTemplate(content.text, varsFromContext(ctx)) || undefined,
    });
    return;
  }
  if (content.type === "video" && isHttpUrl(content.mediaUrl)) {
    await ctx.api.sendVideo(chatId, content.mediaUrl, {
      caption: renderMenuTemplate(content.text, varsFromContext(ctx)) || undefined,
    });
    return;
  }
  if (content.type === "media_group" && content.items.length > 0) {
    await ctx.api.sendMediaGroup(
      chatId,
      content.items.map((item) => ({
        type: item.type,
        media: item.url,
        caption: renderMenuTemplate(item.caption, varsFromContext(ctx)) || undefined,
      })),
    );
    return;
  }
  const text = renderMenuTemplate(content.text, varsFromContext(ctx));
  await ctx.reply(text || "（未配置回复内容）");
}

export function validateMenuConfig(config: BotMenuConfig): MenuValidationResult {
  const stats = countMenuStats(config.root);
  if (stats.buttons === 0) {
    return { ok: false, reason: "主菜单至少需要一个按钮" };
  }
  if (stats.buttons > MENU_MAX_BUTTONS_TOTAL) {
    return { ok: false, reason: `按钮总数不能超过 ${MENU_MAX_BUTTONS_TOTAL} 个` };
  }
  if (stats.depth > MENU_MAX_DEPTH) {
    return { ok: false, reason: `子菜单最多嵌套 ${MENU_MAX_DEPTH} 层` };
  }
  const content = config.content;
  if (content.type === "photo" && !isHttpUrl(content.mediaUrl)) {
    return { ok: false, reason: "图文消息的图片地址不合法（需 http/https）" };
  }
  if (content.type === "video" && !isHttpUrl(content.mediaUrl)) {
    return { ok: false, reason: "视频消息的地址不合法（需 http/https）" };
  }
  if (content.type === "media_group" && content.items.length === 0) {
    return { ok: false, reason: "相册消息至少需要一个图片或视频" };
  }
  const validateNode = (node: MenuNode, depth: number): string | null => {
    if (node.rows.length > MENU_MAX_ROWS) return `按钮行数不能超过 ${MENU_MAX_ROWS} 行`;
    for (const row of node.rows) {
      if (row.buttons.length > MENU_MAX_BUTTONS_PER_ROW) {
        return `每行最多 ${MENU_MAX_BUTTONS_PER_ROW} 个按钮`;
      }
      for (const button of row.buttons) {
        if (button.action.type === "reply") {
          const replyContent = normalizeReplyContent(button.action);
          if (!replyContent.text.trim() && replyContent.type === "text") {
            return `按钮「${button.text}」的回复内容不能为空`;
          }
          if (replyContent.type === "photo" && !isHttpUrl(replyContent.mediaUrl)) {
            return `按钮「${button.text}」的图片地址不合法`;
          }
          if (replyContent.type === "video" && !isHttpUrl(replyContent.mediaUrl)) {
            return `按钮「${button.text}」的视频地址不合法`;
          }
          if (replyContent.type === "media_group" && replyContent.items.length === 0) {
            return `按钮「${button.text}」的相册至少需要一个图片或视频`;
          }
        }
        if (button.action.type === "api" && (!button.action.api || !isHttpUrl(button.action.api.url))) {
          return `按钮「${button.text}」的接口地址不合法`;
        }
        if (
          (button.action.type === "url" || button.action.type === "web_app") &&
          !isHttpUrl(button.action.url ?? "")
        ) {
          return `按钮「${button.text}」的链接地址不合法`;
        }
        if (button.action.type === "submenu" && !button.submenu && depth < MENU_MAX_DEPTH) {
          return `按钮「${button.text}」还没有创建子菜单`;
        }
        if (button.submenu) {
          const childError = validateNode(button.submenu, depth + 1);
          if (childError) return childError;
        }
      }
    }
    return null;
  };
  const nodeError = validateNode(config.root, 1);
  if (nodeError) return { ok: false, reason: nodeError };
  return { ok: true };
}

export interface MenuValidationOk {
  ok: true;
}

export interface MenuValidationError {
  ok: false;
  reason: string;
}

export type MenuValidationResult = MenuValidationOk | MenuValidationError;

type MenuApi = Api;

type SendMessageExtra = NonNullable<Parameters<MenuApi["sendMessage"]>[2]>;
export type MenuReplyMarkup = SendMessageExtra["reply_markup"];

export async function sendMenuMessage(
  api: MenuApi,
  chatId: number | string,
  content: MenuMessageContent,
  options?: { replyMarkup?: MenuReplyMarkup; keyboardText?: string },
): Promise<{ messageId: number; keyboardOnAlbum: boolean }> {
  const markup = options?.replyMarkup;
  if (content.type === "photo" && isHttpUrl(content.mediaUrl)) {
    const sent = await api.sendPhoto(chatId, content.mediaUrl, {
      caption: content.text || undefined,
      ...(markup ? { reply_markup: markup } : {}),
    });
    return { messageId: sent.message_id, keyboardOnAlbum: false };
  }
  if (content.type === "video" && isHttpUrl(content.mediaUrl)) {
    const sent = await api.sendVideo(chatId, content.mediaUrl, {
      caption: content.text || undefined,
      ...(markup ? { reply_markup: markup } : {}),
    });
    return { messageId: sent.message_id, keyboardOnAlbum: false };
  }
  if (content.type === "media_group" && content.items.length > 0) {
    await api.sendMediaGroup(
      chatId,
      content.items.map((item) => ({
        type: item.type,
        media: item.url,
        caption: item.caption || undefined,
      })),
    );
    const keyboardMessage = await api.sendMessage(
      chatId,
      options?.keyboardText?.trim() || "请使用下方按钮",
      options?.replyMarkup ? { reply_markup: options.replyMarkup } : undefined,
    );
    return { messageId: keyboardMessage.message_id, keyboardOnAlbum: true };
  }
  const sent = await api.sendMessage(chatId, content.text || "（未配置内容）", {
    ...(options?.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
  });
  return { messageId: sent.message_id, keyboardOnAlbum: false };
}
