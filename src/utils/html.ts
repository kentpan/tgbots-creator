export function htmlEscape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

/**
 * 群内消息中的用户提及（HTML parse_mode）：
 * - 有 username → 直接 @handle（Telegram 原生可点击，无需实体）；
 * - 无 username → tg://user?id= 文本提及（仅当被提及人当前在群内才可点击，
 *   群内验证场景中新成员必然在群内，满足条件）。
 */
export function userMentionHTML(user: {
  id: number;
  username?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}): string {
  if (user.username) {
    return `@${user.username}`;
  }
  const name =
    [user.first_name, user.last_name]
      .filter((part) => Boolean(part && String(part).trim()))
      .map((part) => htmlEscape(String(part)))
      .join(" ") || "新成员";
  return `<a href="tg://user?id=${user.id}">${name}</a>`;
}
