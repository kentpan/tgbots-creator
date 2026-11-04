const SPECIAL_CHARS = [
  "\\",
  "_",
  "*",
  "[",
  "]",
  "(",
  ")",
  "~",
  "`",
  ">",
  "#",
  "+",
  "-",
  "=",
  "|",
  "{",
  "}",
  ".",
  "!",
];

export function escapeMarkdownV2(text: string): string {
  if (!text) return "";
  let result = text;
  for (const char of SPECIAL_CHARS) {
    result = result.replaceAll(char, `\\${char}`);
  }
  return result;
}

export function formatUserMention(username: string | null | undefined, firstName: string): string {
  if (username) {
    return `@${escapeMarkdownV2(username)}`;
  }
  return escapeMarkdownV2(firstName);
}

export function formatCodeInline(text: string): string {
  return `\`${text}\``;
}

export function formatBold(text: string): string {
  return `*${escapeMarkdownV2(text)}*`;
}

export function formatItalic(text: string): string {
  return `_${escapeMarkdownV2(text)}_`;
}

export function formatLink(text: string, url: string): string {
  return `[${escapeMarkdownV2(text)}](${url})`;
}
