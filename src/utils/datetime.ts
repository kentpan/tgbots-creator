/**
 * 北京时间（Asia/Shanghai）统一格式化工具（v2.0.13）
 *
 * 背景：服务器/Edge 运行时时区不可控（Cloudflare Workers 恒为 UTC、
 * 本地沙盒多为 UTC），此前各管理页用 getFullYear()/getHours() 等本地时区
 * 方法拼时间，线上展示比北京时间晚 8 小时（用户实测
 * /admin/join-requests「申请时间不是北京时间」）。
 *
 * 本模块用 Intl.DateTimeFormat 显式锁定 timeZone="Asia/Shanghai"，
 * server / client / node / edge 全环境一致，时区永远正确。
 *
 * hourCycle: "h23" —— zh-CN 部分运行时 hour12:false 会把 0 点输出为 "24"，
 * h23 强制 0-23 小时制。
 */

const BEIJING_TIME_ZONE = "Asia/Shanghai";

function extractBeijingParts(
  date: Date,
  formatter: Intl.DateTimeFormat,
): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return parts;
}

const FULL_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: BEIJING_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const MINUTE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: BEIJING_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const SHORT_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: BEIJING_TIME_ZONE,
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function joinParts(
  parts: Record<string, string>,
  keys: [string, string, string, string, string, string],
): string {
  const [y, mo, d, h, mi, s] = keys.map((key) => parts[key] ?? "");
  return s
    ? `${y}-${mo}-${d} ${h}:${mi}:${s}`
    : `${y}-${mo}-${d} ${h}:${mi}`;
}

/** 北京时间 "YYYY-MM-DD HH:mm:ss"；null/undefined/Invalid Date → "-" */
export function formatBeijingDateTime(date: Date | null | undefined): string {
  if (!date || Number.isNaN(date.getTime())) return "-";
  return joinParts(extractBeijingParts(date, FULL_FORMATTER), [
    "year",
    "month",
    "day",
    "hour",
    "minute",
    "second",
  ]);
}

/** 北京时间 "YYYY-MM-DD HH:mm"；null/undefined/Invalid Date → "-" */
export function formatBeijingDateTimeMinute(
  date: Date | null | undefined,
): string {
  if (!date || Number.isNaN(date.getTime())) return "-";
  return joinParts(extractBeijingParts(date, MINUTE_FORMATTER), [
    "year",
    "month",
    "day",
    "hour",
    "minute",
    "",
  ]);
}

/** 北京时间 "MM-DD HH:mm:ss"（列表/日志等紧凑列）；null/undefined/Invalid Date → "-" */
export function formatBeijingShortDateTime(
  date: Date | null | undefined,
): string {
  if (!date || Number.isNaN(date.getTime())) return "-";
  const parts = extractBeijingParts(date, SHORT_FORMATTER);
  const pad = (key: string): string => parts[key] ?? "";
  return `${pad("month")}-${pad("day")} ${pad("hour")}:${pad("minute")}:${pad("second")}`;
}
