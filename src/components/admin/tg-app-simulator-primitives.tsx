"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { AppSimGroup, SimInviteLinkEntry } from "@/components/admin/tg-app-simulator-types";

/** Telegram iOS 仿真面板共用色板，统一群组设置/新建群组/代理页视觉。 */
export const IOS_BLUE = "#3390ec";
export const IOS_GREEN = "#34c759";
export const IOS_GRAY_BG = "#efeff4";
export const IOS_TEXT_SECONDARY = "#8e8e93";

const NAME_COLORS = ["#e17076", "#faa774", "#a695e7", "#7bc862", "#6ec9cb", "#65aadd", "#ee7aae"];

function nameColor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return NAME_COLORS[hash % NAME_COLORS.length];
}


/** 会话搜索辅助：识别 Telegram 邀请链接或本项目 join 深链。 */
export function isInviteSearch(value: string): boolean {
  return /t\.me\/(\+|joinchat\/)/i.test(value) || /start=join_-?\d+/i.test(value);
}

/** 过滤会话列表；邀请链接由独立解析流程处理，不参与群名/ID过滤。 */
export function filterSimulatorGroups(groups: AppSimGroup[], search: string): AppSimGroup[] {
  const keyword = search.trim().toLowerCase();
  if (!keyword || isInviteSearch(search)) return groups;
  return groups.filter((group) =>
    group.chatTitle.toLowerCase().includes(keyword) || group.chatId.includes(keyword),
  );
}

/** 汇总会话未读申请数。 */
export function sumSimulatorUnread(groups: AppSimGroup[]): number {
  return groups.reduce((sum, group) => sum + group.unread, 0);
}

/** 按邀请链接创建者分组，保留输入顺序。 */
export function groupInviteLinksByCreator(
  entries: SimInviteLinkEntry[],
  bots: Array<{ id: string; name: string }>,
): Array<{ key: string; label: string; items: SimInviteLinkEntry[] }> {
  const byCreator = new Map<string, SimInviteLinkEntry[]>();
  for (const entry of entries) {
    const key = entry.bot_id ?? "";
    const list = byCreator.get(key) ?? [];
    list.push(entry);
    byCreator.set(key, list);
  }
  return [...byCreator.entries()].map(([key, items]) => ({
    key,
    label: key ? (bots.find((bot) => bot.id === key)?.name ?? `机器人 #${key}`) : "未登记创建者",
    items,
  }));
}

/** 浮层动画（设置/权限/加群确认面板：右侧滑入） */
export const OVERLAY_VARIANTS = {
  enter: { x: "100%" },
  center: { x: "0%" },
  exit: { x: "100%" },
};

/** 列表时间列：当天显示 HH:mm，更早显示 M/D（与真实 Telegram 会话列表一致） */
function formatListTime(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  if (date.toDateString() === now.toDateString()) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/**
 * 水合安全的列表时间列。
 *
 * formatListTime 依赖本地时区（getHours/getMinutes）：SSR 用服务器时区（UTC）
 * 渲染出的 HH:mm 与客户端（如 UTC+8）不一致，触发 "server rendered text didn't
 * match the client" hydration 错误。因此 mount 前与 SSR 保持一致渲染空字符串，
 * mount 后再写入本地时区时间，并每 30 秒刷新（保证跨天 M/D 判定持续正确）。
 */
export function ListTime({ iso, active }: { iso: string; active?: boolean }) {
  const [value, setValue] = useState("");
  useEffect(() => {
    const update = (): void => setValue(formatListTime(iso));
    update();
    const timer = window.setInterval(update, 30000);
    return () => window.clearInterval(timer);
  }, [iso]);
  return (
    <span className={`shrink-0 text-[13px] ${active ? "text-white/85" : "text-[#8e8e93]"}`}>{value}</span>
  );
}

export function methodLabel(method: string | null): string {
  if (method === "code_self") return "自动验证码";
  if (method === "code_api") return "自定义验证码";
  if (method === "captcha") return "人机验证码";
  return "未配置验证";
}

/** 安全解析响应 JSON：空响应体 / 非 JSON（如 500 错误页）不再抛 "Unexpected end of JSON input" */
export async function readJson<T>(response: Response): Promise<T | null> {
  try {
    const text = await response.text();
    if (!text.trim()) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}


/** 加群申请时间格式化：固定使用 Asia/Shanghai，避免客户端设备时区差异。 */
export function formatJoinRequestTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function GroupAvatar({ title, size }: { title: string; size: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, backgroundColor: nameColor(title), fontSize: size * 0.42 }}
      aria-hidden
    >
      {title.slice(0, 1) || "?"}
    </div>
  );
}

export function IosRowIcon({ bg, children }: { bg: string; children: ReactNode }) {
  return (
    <span
      className="flex h-[29px] w-[29px] shrink-0 items-center justify-center rounded-[7px] text-white"
      style={{ backgroundColor: bg }}
      aria-hidden
    >
      {children}
    </span>
  );
}

/**
 * Telegram 桌面端绿色涂鸦壁纸（截图1/截图2 背景）：
 * 绿色渐变底 + 白色描边涂鸦图案（SVG pattern 内联渲染，避免 data-URI 编码问题）。
 */
export function DoodleWallpaper() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" style={{ backgroundColor: "#94bd8a" }} aria-hidden>
      <div
        className="absolute inset-0"
        style={{ backgroundImage: "linear-gradient(160deg, #a9cb9a 0%, #8fb886 48%, #9dc191 100%)" }}
      />
      <svg className="absolute inset-0 h-full w-full" aria-hidden>
        <defs>
          <pattern id="tg-desktop-doodles" width="300" height="300" patternUnits="userSpaceOnUse">
            <g
              fill="none"
              stroke="#ffffff"
              strokeOpacity="0.32"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {/* 爱心 */}
              <path d="M38 64c-9-8.5-15-14-15-21.5C23 36 28 31 34.5 31c3.6 0 6.5 2.4 3.5 5.8C41 33.4 44 31 47.5 31 54 31 59 36 59 42.5 59 50 53 55.5 44 64l-6 5.4z" transform="scale(0.62) translate(8 -18)" />
              {/* 五角星 */}
              <path d="M156 20l5.4 11 12.1 1.7-8.8 8.5 2.1 12-10.8-5.7-10.8 5.7 2.1-12-8.8-8.5 12.1-1.7z" />
              {/* 笑脸 */}
              <circle cx="262" cy="52" r="13" />
              <circle cx="257.5" cy="49" r="1.3" fill="#ffffff" stroke="none" />
              <circle cx="266.5" cy="49" r="1.3" fill="#ffffff" stroke="none" />
              <path d="M256.5 55c1.6 2.2 4 3.4 5.5 3.4s3.9-1.2 5.5-3.4" />
              {/* 纸飞机 */}
              <path d="M52 138l52-18-34 38-5.5-13.5z" />
              <path d="M64.5 144.5L104 120" />
              {/* 音符 */}
              <path d="M204 158v-26l16-5v26" />
              <circle cx="200" cy="158" r="4.6" />
              <circle cx="216" cy="153" r="4.6" />
              {/* 小房子 */}
              <path d="M30 216l15-13 15 13" />
              <path d="M35 212v18h20v-18" />
              <path d="M42 230v-9h6v9" />
              {/* 螺旋 */}
              <path d="M148 246c0-5 4-9 9-9s9 4 9 9-4 9-9 9-13-4-13-11 6-15 15-15 16 7 16 17" />
              {/* 气球 */}
              <ellipse cx="258" cy="222" rx="11" ry="13" />
              <path d="M258 235l-2.5 5h5z" />
              <path d="M258 240c0 8-6 10-6 17" />
              {/* 十字与圆点散布 */}
              <path d="M112 62v10M107 67h10" />
              <path d="M236 116v8M232 120h8" />
              <circle cx="86" cy="196" r="2.2" fill="#ffffff" stroke="none" />
              <circle cx="176" cy="96" r="2.2" fill="#ffffff" stroke="none" />
              <circle cx="30" cy="150" r="2.2" fill="#ffffff" stroke="none" />
              <circle cx="284" cy="160" r="2.2" fill="#ffffff" stroke="none" />
              {/* 云朵 */}
              <path d="M92 268c-5 0-8-3.4-8-7.6 0-4.2 3.4-7.4 7.6-7.4 1.2-4.6 5.4-7.6 10-7.2 4.4.4 8 3.6 8.8 7.8 3.8.4 6.6 3.4 6.6 7 0 4-3.2 7.4-7.6 7.4z" />
            </g>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#tg-desktop-doodles)" />
      </svg>
    </div>
  );
}

