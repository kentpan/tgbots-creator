import type { Api } from "grammy";
import { htmlEscape } from "@/utils/html";
import { codeQuestion } from "./verification-question";

/**
 * code_self 验证方式（v1.1.7）的私聊验证码提示 —— 机器人自生成验证码、
 * 用户回复输入的「输入验证码加群」模式（参考 Telegram 进群答题/对暗号验证方案）。
 *
 * 提示消息由 chat-member.ts（入群申请/直连入群 bootstrap）与 admin.ts
 * （/start 重发 pending 会话）共用，保证首次发送与重发的文案/交互完全一致。
 *
 * 隐私红线（同 v1.1.3）：提示只发用户私聊，群组内绝不出现验证消息。
 * 交互与 code_api 保持同一通道：stateless-question 隐形后缀 + force_reply，
 * 用户回复提示消息输入验证码 → 机器人本地比对（见 verification-flow.ts）。
 */

/** code_self 方式的默认提示正文（group_settings.prompt_text 未配置时使用） */
export const CODE_SELF_DEFAULT_PROMPT = "🔐 请回复本消息并输入验证码完成验证";

/**
 * 组装 code_self 提示消息（HTML）：
 * {promptText} + 验证码高亮块 + 有效期说明 + stateless-question 隐形后缀。
 *
 * @param promptText 群组配置的提示正文（原样转义为 HTML）
 * @param code       机器人自生成的入群验证码（纯数字，安全字符，无需转义）
 * @param expiresAt  会话过期时间（用于换算「N 分钟内有效」）
 */
export function buildCodeSelfPromptHTML(
  promptText: string,
  code: string,
  expiresAt: Date,
): string {
  const minutes = Math.max(1, Math.round((expiresAt.getTime() - Date.now()) / 60000));
  return (
    htmlEscape(promptText) +
    "\n\n" +
    `您的入群验证码：<b>${htmlEscape(code)}</b>` +
    "\n\n" +
    `⏱ 验证码 ${minutes} 分钟内有效，请回复本消息并输入上述验证码完成验证，` +
    "验证通过后将自动批准入群。请勿把验证码泄露给他人。" +
    codeQuestion.messageSuffixHTML()
  );
}

/** code_self 提示消息的回复标记（与 code_api 验证提示一致的 force_reply 交互） */
export const CODE_SELF_REPLY_MARKUP = {
  force_reply: true,
  input_field_placeholder: "输入验证码",
} as const;

export interface CodeSelfPromptDelivery {
  /** 提示是否成功送达用户私聊 */
  delivered: boolean;
  /** true = 用户尚未 /start 机器人，私聊不可达（等 /start 重发或超时清理） */
  chatNotFound: boolean;
}

/**
 * 发送 code_self 验证提示到用户私聊。
 * 发送失败不抛出（通知层失败不允许中断 bootstrap 主流程），由调用方按
 * delivered/chatNotFound 决定后续行为并记录日志。
 */
export async function sendCodeSelfPrompt(
  api: Api,
  userId: number,
  options: { promptText: string; code: string; expiresAt: Date; contextLabel: string },
): Promise<CodeSelfPromptDelivery> {
  try {
    await api.sendMessage(
      userId,
      buildCodeSelfPromptHTML(options.promptText, options.code, options.expiresAt),
      {
        parse_mode: "HTML",
        // 隐形后缀的 t.me 链接实体不触发链接预览卡片（保持提示消息干净）
        link_preview_options: { is_disabled: true },
        reply_markup: CODE_SELF_REPLY_MARKUP,
      },
    );
    console.log(
      `Code self verification prompt sent to user ${userId} (${options.contextLabel})`,
    );
    return { delivered: true, chatNotFound: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("chat not found")) {
      // 用户尚未启动机器人，私聊不可达（Telegram 官方限制）。
      // 隐私红线：绝不在群里发任何消息提示；/start 时会重发验证提示。
      console.warn(
        `Cannot send code self prompt to user ${userId} (${options.contextLabel}): ` +
          "user hasn't started bot; prompt will be resent when the user /starts the bot; " +
          "session expires per timeout",
      );
      return { delivered: false, chatNotFound: true };
    }
    console.error(
      `Failed to send code self verification prompt to user ${userId} (${options.contextLabel}):`,
      error,
    );
    return { delivered: false, chatNotFound: false };
  }
}
