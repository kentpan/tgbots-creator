/**
 * Shared default copy for ordinary Telegram bots.
 * Custom /start text is stored in bots.config.welcomeText; these constants are
 * fallback content only, so the default message has one source of truth.
 */
export const DEFAULT_BOT_START_WELCOME_MARKDOWN_V2 =
  "🤖 *TGuard 群组验证机器人*\n\n" +
  "🛡️ *自动验证新成员身份，防止机器人和恶意用户进入群组*\n\n" +
  "*功能：*\n" +
  "• 新成员申请加群时自动发送验证链接\n" +
  "• 通过人机验证后自动批准加群\n" +
  "• 支持多种验证码服务\\(hCaptcha、Cap\\.js、Turnstile\\)\n\n" +
  "使用 `/help` 查看更多信息\n\n" +
  "👇 也可以直接点击下方菜单按钮：";

export const DEFAULT_BOT_HELP_MARKDOWN_V2 =
  "🤖 *TGuard 群组验证机器人*\n\n" +
  "🛡️ *自动验证新成员身份，防止机器人和恶意用户进入群组*\n\n" +
  "*使用说明：*\n" +
  "如何使用请见 [README](https://github.com/SideCloudGroup/TGuard/blob/main/README.md)\n\n" +
  "*技术支持：*\n" +
  "由 [TGuard](https://github.com/SideCloudGroup/TGuard) 提供技术支持";
