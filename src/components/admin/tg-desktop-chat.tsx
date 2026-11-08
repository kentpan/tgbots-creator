"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ChevronDown,
  Loader2,
  Mic,
  MoreVertical,
  Paperclip,
  Search,
  SendHorizontal,
  Smile,
  UserRoundPlus,
} from "lucide-react";
import {
  executeMenuApi,
  renderMenuTemplate,
  type BotMenuConfig,
  type MenuButton,
  type MenuMediaItem,
  type MenuMessageContent,
  type MenuNode,
  type MenuTemplateVars,
} from "@/services/menu-config";

/**
 * Telegram 桌面客户端风格聊天区（机器人测试页右侧群组内对话区域，v2.0.14）。
 *
 * 完全复刻 Telegram Desktop（macOS）会话视图：
 *   · 顶部浮动白色圆角标题条（头像 + 群名 + 成员数，右侧搜索 / 更多按钮）
 *   · 绿色涂鸦壁纸上的消息流：日期胶囊「今天」/ 服务消息胶囊 / 白色气泡（发送者名 + 管理员徽章）
 *   · 内嵌键盘按钮（浅绿半透明，截图2 的「验证说明 / 测试入口」样式）
 *   · 底部浮动输入条（回形针 + 白色圆角输入框 + 麦克风/发送）
 *   · 右下角浮动「滚动到底部」圆钮
 *
 * 消息流逻辑与 tg-simulator.tsx（iOS 仿真屏）同源：菜单消息 + 加群验证全流程，
 * 群组视图 / 机器人私聊视图双消息流隔离（隐私红线：验证码只出现在私聊流）。
 */

interface SimMessage {
  id: number;
  from: "bot" | "user" | "system";
  sender: string;
  content: MenuMessageContent;
  loading?: boolean;
  /** 系统消息色调：error 时以红色胶囊展示（如申请加入失败原因） */
  tone?: "info" | "error";
  /** 消息创建时的客户端时间（HH:mm）；创建后固定，避免重渲染时变化 */
  time: string;
}

const NAME_COLORS = ["#e17076", "#faa774", "#a695e7", "#7bc862", "#6ec9cb", "#65aadd", "#ee7aae"];

function nameColor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return NAME_COLORS[hash % NAME_COLORS.length];
}

function nowTime(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

// —— 水合安全时钟（SSR 返回空快照，水合后本地时间）——
let chatClockCache: { minute: number; value: string } = { minute: -1, value: "" };

function subscribeClock(onStoreChange: () => void): () => void {
  const timer = window.setInterval(onStoreChange, 15000);
  return () => window.clearInterval(timer);
}

function getClockSnapshot(): string {
  const now = new Date();
  const minute = now.getHours() * 60 + now.getMinutes();
  if (chatClockCache.minute !== minute) {
    chatClockCache = { minute, value: nowTime() };
  }
  return chatClockCache.value;
}

function getServerClockSnapshot(): string {
  return "";
}

/** 头像（首字母圆形，色板与 Telegram 一致） */
function ChatAvatar({ name, size }: { name: string; size: number }) {
  return (
    <div
      className="flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, backgroundColor: nameColor(name), fontSize: size * 0.42 }}
      aria-hidden
    >
      {name.slice(0, 1) || "?"}
    </div>
  );
}

function MediaBlock({ content }: { content: MenuMessageContent }) {
  const [failed, setFailed] = useState(false);
  if (content.type === "photo" && content.mediaUrl) {
    return (
      <div className="space-y-1.5">
        {!failed ? (
          <img
            src={content.mediaUrl}
            alt="图片消息"
            className="max-h-72 w-full rounded-lg object-cover"
            onError={() => setFailed(true)}
          />
        ) : (
          <div className="flex h-36 items-center justify-center rounded-lg bg-black/10 text-sm text-black/50">
            图片无法加载（地址不可用）
          </div>
        )}
        {content.text ? (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-[#0f0f0f]">{content.text}</p>
        ) : null}
      </div>
    );
  }
  if (content.type === "video" && content.mediaUrl) {
    return (
      <div className="space-y-1.5">
        <video src={content.mediaUrl} controls playsInline muted className="max-h-72 w-full rounded-lg bg-black" />
        {content.text ? (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-[#0f0f0f]">{content.text}</p>
        ) : null}
      </div>
    );
  }
  if (content.type === "media_group" && content.items.length > 0) {
    const items: MenuMediaItem[] = content.items;
    const single = items.length === 1;
    return (
      <div className="space-y-1.5">
        <div className={`grid overflow-hidden rounded-lg ${single ? "grid-cols-1" : "grid-cols-2 gap-[2px]"}`}>
          {items.map((item, index) =>
            item.type === "video" ? (
              <video key={index} src={item.url} controls playsInline muted className="h-44 w-full bg-black object-cover" />
            ) : (
              <img key={index} src={item.url} alt="相册图片" className="h-44 w-full object-cover" />
            ),
          )}
        </div>
        {content.text ? (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-[#0f0f0f]">{content.text}</p>
        ) : null}
      </div>
    );
  }
  return null;
}

/** 内嵌键盘（截图2：浅绿半透明按钮，附着在菜单消息气泡下方） */
function InlineKeyboard({
  node,
  pressedId,
  onButtonClick,
}: {
  node: MenuNode;
  pressedId: string | null;
  onButtonClick: (button: MenuButton) => void;
}) {
  if (node.rows.length === 0) return null;
  return (
    <div className="mt-1 w-full space-y-1">
      {node.rows.map((row, rowIndex) => (
        <div key={row.id || rowIndex} className="flex gap-1">
          {row.buttons.map((button) => (
            <button
              key={button.id || button.text}
              type="button"
              onClick={() => onButtonClick(button)}
              className={`min-w-0 flex-1 truncate rounded-[10px] px-2 py-2.5 text-center text-[14px] text-[#1c1e21] transition-colors ${
                pressedId === button.id
                  ? "bg-black/20"
                  : "bg-[#e6ffd9]/80 hover:bg-[#e6ffd9] active:bg-black/15"
              }`}
              style={{ backdropFilter: "blur(3px)", WebkitBackdropFilter: "blur(3px)" }}
              title={button.text}
            >
              {button.text}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

/** 气泡内嵌时间戳（float 右侧，与 Telegram 桌面端一致；outgoing 附 ✓✓） */
function BubbleTime({ outgoing, time }: { outgoing: boolean; time: string }) {
  return (
    <span
      className={`float-right ml-3 mt-1 select-none whitespace-nowrap text-[12px] leading-none ${
        outgoing ? "text-[#4a8a4f]" : "text-[#9db1c0]"
      }`}
    >
      {time}
      {outgoing ? " ✓✓" : ""}
    </span>
  );
}

const AVATAR_SIZE = 34;
const AVATAR_GAP = 8;

export function TgDesktopChat({
  config,
  botName,
  groupTitle,
  memberCount,
  isPrivate,
  systemNote,
  templateVars,
  promptMessage,
  onUserSend,
  joinPhase,
  onRequestJoin,
  onOpenSettings,
  onBackToList,
  pendingJoinCount = 0,
  onOpenJoinRequests,
}: {
  config: BotMenuConfig;
  botName: string;
  /** 群组视图：群名称；私聊视图：机器人名称 */
  groupTitle: string;
  /** 群组视图副标题（如「仿真模式」） */
  memberCount?: string;
  /** true = 与机器人的私聊（验证码在此输入，隐私模式）；false = 群组聊天 */
  isPrivate: boolean;
  /** 服务消息提示条（仿真流程说明），以 Telegram 服务消息胶囊样式展示 */
  systemNote?: string;
  /** 覆盖菜单模板变量（真实的 chat_id / user_id 等仿真群组上下文） */
  templateVars?: Partial<MenuTemplateVars>;
  /** 外部注入的机器人消息（加群验证提示），由父组件控制生命周期 */
  promptMessage?: { id: number; text: string; hint?: string } | null;
  /** 用户发送文本消息的处理器（如提交验证码）；未提供时保持本地回显行为 */
  onUserSend?: (text: string) => Promise<{ ok: boolean; text: string; joined?: boolean }>;
  /** 加群仿真阶段：idle=尚未加入（底部显示「申请加入群组」按钮），awaiting_code/joined=显示输入框 */
  joinPhase?: "idle" | "awaiting_code" | "joined";
  /** 点击「申请加入群组」按钮时触发（父组件创建加群申请会话）；失败原因以红色服务消息展示 */
  onRequestJoin?: () => Promise<{ ok: boolean; message: string }>;
  /** 点击头像 / 更多按钮 → 打开群组设置（由外壳组件承载） */
  onOpenSettings: () => void;
  /** 移动端返回列表（桌面端双栏常驻不显示返回钮） */
  onBackToList?: () => void;
  /** v2.0.16 待处理加群申请数（>0 时聊天区顶部展示醒目横幅，点击打开上滑申请列表） */
  pendingJoinCount?: number;
  /** v2.0.16 点击加群申请横幅 → 打开上滑加群申请列表（由外壳组件承载） */
  onOpenJoinRequests?: () => void;
}) {
  const clock = useSyncExternalStore(subscribeClock, getClockSnapshot, getServerClockSnapshot);
  const history = useRef<string[]>([]);
  const [messages, setMessages] = useState<SimMessage[]>([]);
  // 与机器人的私聊消息流（验证码在此输入，与群组消息完全隔离）
  const [dmMessages, setDmMessages] = useState<SimMessage[]>([]);
  const [input, setInput] = useState("");
  const [pressed, setPressed] = useState<string | null>(null);
  const [requestingJoin, setRequestingJoin] = useState(false);
  const [sending, setSending] = useState(false);
  const [nodeId, setNodeId] = useState("root");
  const [showScrollDown, setShowScrollDown] = useState(false);
  const nextId = useRef(1);
  const scrollRef = useRef<HTMLDivElement>(null);

  const currentNode = useMemo<MenuNode>(() => {
    if (nodeId === "root") return config.root;
    let node: MenuNode | undefined;
    const walk = (current: MenuNode): void => {
      for (const row of current.rows) {
        for (const button of row.buttons) {
          if (button.id === nodeId && button.submenu) {
            node = button.submenu;
            return;
          }
          if (button.submenu) walk(button.submenu);
        }
      }
    };
    walk(config.root);
    return node ?? config.root;
  }, [config, nodeId]);

  const vars: MenuTemplateVars = {
    chat_id: "-1001998877661",
    user_id: "777000",
    username: "preview_user",
    first_name: "预览",
    last_name: "用户",
    chat_title: groupTitle,
    message_id: "1024",
    ...(templateVars ?? {}),
  };

  const stream: "group" | "dm" = isPrivate ? "dm" : "group";
  const visibleMessages = isPrivate ? dmMessages : messages;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [visibleMessages.length, isPrivate, nodeId]);

  /** 向指定消息流追加消息（group=群组聊天，dm=与机器人的私聊） */
  const appendStream = (target: "group" | "dm", message: Omit<SimMessage, "id" | "time">): void => {
    const entry = { ...message, id: nextId.current++, time: nowTime() };
    if (target === "dm") setDmMessages((prev) => [...prev, entry]);
    else setMessages((prev) => [...prev, entry]);
  };

  const patchStream = (target: "group" | "dm", id: number, patch: Partial<SimMessage>): void => {
    const setter = target === "dm" ? setDmMessages : setMessages;
    setter((prev) => prev.map((message) => (message.id === id ? { ...message, ...patch } : message)));
  };

  // 进入私聊视图：以服务消息说明隐私语义（验证码仅机器人可见，群里看不到）
  useEffect(() => {
    if (!isPrivate) return;
    setDmMessages((prev) => [
      ...prev,
      {
        id: nextId.current++,
        from: "system",
        sender: "system",
        content: {
          type: "text",
          text: "已切换到与机器人的私聊（隐私模式：验证码仅机器人可见，不会出现在群里）",
          mediaUrl: "",
          items: [],
        },
        time: nowTime(),
      },
    ]);
  }, [isPrivate]);

  const handleButtonClick = async (button: MenuButton): Promise<void> => {
    if (pressed) return;
    setPressed(button.id ?? button.text);
    setTimeout(() => setPressed(null), 250);

    const action = button.action;
    if (action.type === "submenu") {
      if (button.submenu) {
        history.current.push(nodeId);
        setNodeId(button.id);
      }
      return;
    }
    if (action.type === "back") {
      const target = history.current.pop() ?? "root";
      setNodeId(target);
      return;
    }
    if (action.type === "url" || action.type === "web_app") {
      if (action.url) window.open(action.url, "_blank", "noopener");
      return;
    }
    if (action.type === "switch_inline" || action.type === "switch_inline_current") {
      setInput(action.switch_query ?? "");
      return;
    }
    if (action.type === "reply") {
      const text = action.content?.text || action.text || "";
      const content: MenuMessageContent =
        action.content && (action.content.type !== "text" || text)
          ? { ...action.content, text: renderMenuTemplate(text, vars) }
          : { type: "text", text: renderMenuTemplate(text, vars) || "（未配置回复内容）", mediaUrl: "", items: [] };
      appendStream(stream, { from: "bot", sender: botName, content });
      return;
    }
    if (action.type === "api" && action.api) {
      const loadingId = nextId.current;
      appendStream(stream, {
        from: "bot",
        sender: botName,
        content: { type: "text", text: "", mediaUrl: "", items: [] },
        loading: true,
      });
      try {
        const result = await executeMenuApi(action.api, vars);
        patchStream(stream, loadingId, {
          loading: false,
          content: {
            type: "text",
            text: result.ok ? result.text : `⚠️ ${result.text}`,
            mediaUrl: "",
            items: [],
          },
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        patchStream(stream, loadingId, {
          loading: false,
          content: { type: "text", text: `⚠️ ${detail}`, mediaUrl: "", items: [] },
        });
      }
    }
  };

  const sendText = async (rawText: string): Promise<void> => {
    const text = rawText.trim();
    if (!text || sending) return;
    appendStream(stream, {
      from: "user",
      sender: "我",
      content: { type: "text", text, mediaUrl: "", items: [] },
    });
    setInput("");
    if (!onUserSend) return;
    const loadingId = nextId.current;
    setSending(true);
    appendStream(stream, {
      from: "bot",
      sender: botName,
      content: { type: "text", text: "", mediaUrl: "", items: [] },
      loading: true,
    });
    try {
      const result = await onUserSend(text);
      patchStream(stream, loadingId, {
        loading: false,
        content: {
          type: "text",
          text: result.ok ? result.text : `⚠️ ${result.text}`,
          mediaUrl: "",
          items: [],
        },
      });
      if (result.ok && result.joined && !isPrivate) {
        appendStream("group", {
          from: "system",
          sender: "system",
          content: { type: "text", text: "验证通过，你已加入群组", mediaUrl: "", items: [] },
        });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      patchStream(stream, loadingId, {
        loading: false,
        content: { type: "text", text: `⚠️ ${detail}`, mediaUrl: "", items: [] },
      });
    } finally {
      setSending(false);
    }
  };

  /** 点击「申请加入群组」：结果以服务消息胶囊展示（失败红色） */
  const handleJoinClick = async (): Promise<void> => {
    if (!onRequestJoin || requestingJoin) return;
    setRequestingJoin(true);
    try {
      const result = await onRequestJoin();
      if (!result.ok) {
        appendStream(stream, {
          from: "system",
          sender: "system",
          content: { type: "text", text: `⚠️ ${result.message}`, mediaUrl: "", items: [] },
          tone: "error",
        });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      appendStream(stream, {
        from: "system",
        sender: "system",
        content: { type: "text", text: `⚠️ ${detail}`, mediaUrl: "", items: [] },
        tone: "error",
      });
    } finally {
      setRequestingJoin(false);
    }
  };

  const handleScroll = useCallback((): void => {
    const el = scrollRef.current;
    if (!el) return;
    setShowScrollDown(el.scrollHeight - el.scrollTop - el.clientHeight > 120);
  }, []);

  /** 机器人消息是否显示头像：连续同一发送者的消息只在最后一条显示（Telegram 分组规则） */
  const firstStreamBotIndex = visibleMessages.findIndex((message) => message.from === "bot");
  // 提示消息后面紧跟菜单消息（同为机器人）→ 群组视图提示消息不显示头像；私聊视图无菜单消息 → 显示
  const showPromptAvatar = isPrivate || firstStreamBotIndex !== 0;
  // 菜单消息显示头像，除非消息流以其机器人消息紧随其后（连续机器人消息的头像后移）
  const showMenuAvatar = !isPrivate && firstStreamBotIndex !== 0;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* —— 顶部浮动标题条（截图2：白色圆角条 + 右侧搜索/更多胶囊） —— */}
      <div className="absolute inset-x-0 top-0 z-10 px-4 pt-3 lg:px-6">
        <div className="mx-auto flex w-full max-w-[980px] items-stretch gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl bg-white/95 py-2 pl-2.5 pr-4 shadow-[0_1px_8px_rgba(0,0,0,0.14)] backdrop-blur-sm">
            {onBackToList ? (
              <button
                type="button"
                onClick={onBackToList}
                aria-label="返回会话列表"
                className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-[#5e6e7e] transition-colors hover:bg-black/[0.06] lg:hidden"
              >
                ‹
              </button>
            ) : null}
            <button
              type="button"
              onClick={onOpenSettings}
              aria-label={isPrivate ? "机器人信息" : "打开群组设置"}
              className="shrink-0 cursor-pointer rounded-full transition-transform active:scale-95"
            >
              {isPrivate ? (
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#3390ec]/15 text-[15px] font-bold text-[#3390ec]">
                  {botName.slice(0, 1)}
                </span>
              ) : (
                <ChatAvatar name={groupTitle} size={40} />
              )}
            </button>
            <button type="button" onClick={onOpenSettings} className="min-w-0 flex-1 cursor-pointer text-left">
              <p className="truncate text-[15px] font-semibold leading-tight text-black">{groupTitle}</p>
              <p className="truncate text-[13px] leading-tight text-[#7d8e99]">
                {isPrivate ? "机器人 · 私聊（验证码仅双方可见）" : (memberCount ?? "仿真模式")}
              </p>
            </button>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 rounded-2xl bg-white/95 px-2.5 shadow-[0_1px_8px_rgba(0,0,0,0.14)] backdrop-blur-sm">
            <span className="flex h-9 w-9 items-center justify-center text-[#5e6e7e]" aria-hidden>
              <Search className="h-5 w-5" />
            </span>
            <button
              type="button"
              onClick={onOpenSettings}
              aria-label={isPrivate ? "机器人信息" : "打开群组设置"}
              className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full text-[#5e6e7e] transition-colors hover:bg-black/[0.06]"
            >
              <MoreVertical className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* —— v2.0.16 待处理加群申请醒目横幅（真实 APP：群成员请求加入时标题条下方蓝色提示条） —— */}
        {!isPrivate && pendingJoinCount > 0 && onOpenJoinRequests ? (
          <button
            type="button"
            onClick={onOpenJoinRequests}
            aria-label={`${pendingJoinCount} 条待处理加群申请，点击查看`}
            className="mx-auto mt-2 flex w-full max-w-[980px] cursor-pointer items-center gap-2 rounded-xl px-4 py-2 text-left shadow-[0_1px_8px_rgba(0,0,0,0.14)] transition-transform active:scale-[0.99]"
            style={{ backgroundColor: "#3390ec" }}
          >
            <UserRoundPlus className="h-4 w-4 shrink-0 text-white" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-white">
              {pendingJoinCount} 条加群请求待处理
            </span>
            <span className="shrink-0 text-[12px] text-white/85">点击查看 ›</span>
          </button>
        ) : null}
      </div>

      {/* —— 消息流（壁纸由外层容器提供） —— */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className={`min-h-0 flex-1 overflow-y-auto px-4 pb-3 lg:px-6 ${
          !isPrivate && pendingJoinCount > 0 && onOpenJoinRequests ? "pt-[122px]" : "pt-[74px]"
        }`}
      >
        <div className="mx-auto flex w-full max-w-[980px] flex-col gap-1.5">
          {/* 日期胶囊（截图2「今天」） */}
          <div className="flex justify-center py-1">
            <span className="rounded-full bg-black/25 px-3 py-1 text-[13px] text-white backdrop-blur-sm">今天</span>
          </div>

          {/* 仿真流程说明（服务消息样式） */}
          {systemNote ? (
            <div className="flex justify-center py-1">
              <span className="max-w-[82%] rounded-2xl bg-black/25 px-3.5 py-1.5 text-center text-xs leading-relaxed text-white backdrop-blur-sm">
                {systemNote}
              </span>
            </div>
          ) : null}

          {/* 验证提示消息（机器人发送；群内验证/私聊验证均渲染） */}
          {promptMessage ? (
            <div
              className={`flex items-end ${showPromptAvatar ? "gap-2" : ""}`}
              style={{ paddingLeft: showPromptAvatar ? 0 : AVATAR_SIZE + AVATAR_GAP }}
            >
              {showPromptAvatar ? <ChatAvatar name={botName} size={AVATAR_SIZE} /> : null}
              <div className="min-w-0 flex-1">
                <div className="w-full rounded-2xl rounded-bl-md bg-white px-3 py-2 shadow-sm">
                  <div className="mb-0.5 flex items-center gap-1.5">
                    <p className="text-[14px] font-semibold" style={{ color: nameColor(botName) }}>
                      {botName}
                    </p>
                    <span className="rounded bg-[#e3fdd0] px-1.5 py-[1px] text-[11px] font-medium text-[#4a8a4f]">
                      管理员
                    </span>
                  </div>
                  <BubbleTime outgoing={false} time={clock} />
                  <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-[#0f0f0f]">
                    {promptMessage.text}
                  </p>
                  <span className="clear-both block h-0" />
                  {promptMessage.hint ? (
                    <p className="mt-1 rounded-md bg-[#3390ec]/10 px-2 py-1 text-[13px] font-medium text-[#3390ec]">
                      ↩︎ {promptMessage.hint}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}

          {/* 菜单消息 + 内嵌键盘（仅群组视图；即截图2 的 TGuard 群组验证机器人消息） */}
          {!isPrivate ? (
            <div className={`flex items-end ${showMenuAvatar ? "gap-2" : ""}`}>
              {showMenuAvatar ? <div className="w-[34px] shrink-0"><ChatAvatar name={botName} size={AVATAR_SIZE} /></div> : <div className="w-[34px] shrink-0" style={{ marginRight: AVATAR_GAP }} />}
              <div className="min-w-0 flex-1">
                <div className="w-full rounded-2xl rounded-bl-md bg-white px-3 py-2 shadow-sm">
                  <div className="mb-0.5 flex items-center gap-1.5">
                    <p className="text-[14px] font-semibold" style={{ color: nameColor(botName) }}>
                      {botName}
                    </p>
                    <span className="rounded bg-[#e3fdd0] px-1.5 py-[1px] text-[11px] font-medium text-[#4a8a4f]">
                      管理员
                    </span>
                  </div>
                  {config.content.type === "text" ? (
                    <>
                      <BubbleTime outgoing={false} time={clock} />
                      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-[#0f0f0f]">
                        {config.content.text}
                      </p>
                      <span className="clear-both block h-0" />
                    </>
                  ) : (
                    <>
                      <BubbleTime outgoing={false} time={clock} />
                      <MediaBlock content={config.content} />
                      <span className="clear-both block h-0" />
                    </>
                  )}
                </div>
                <InlineKeyboard node={currentNode} pressedId={pressed} onButtonClick={handleButtonClick} />
              </div>
            </div>
          ) : null}

          {/* 动态消息流（用户/机器人/服务消息） */}
          {visibleMessages.map((message, index) => {
            if (message.from === "system") {
              return (
                <div key={message.id} className="flex justify-center py-1">
                  <span
                    className={`max-w-[82%] rounded-2xl px-3.5 py-1.5 text-center text-xs leading-relaxed backdrop-blur-sm ${
                      message.tone === "error" ? "bg-red-900/75 text-white" : "bg-black/25 text-white"
                    }`}
                  >
                    {message.content.text}
                  </span>
                </div>
              );
            }
            const outgoing = message.from === "user";
            if (outgoing) {
              return (
                <div key={message.id} className="flex justify-end">
                  <div className="max-w-[86%] rounded-2xl rounded-br-md bg-[#effdde] px-3 py-2 shadow-sm">
                    <BubbleTime outgoing time={message.time} />
                    {message.loading ? (
                      <LoadingDots />
                    ) : message.content.type !== "text" ? (
                      <MediaBlock content={message.content} />
                    ) : (
                      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-[#0f0f0f]">
                        {message.content.text}
                      </p>
                    )}
                    <span className="clear-both block h-0" />
                  </div>
                </div>
              );
            }
            // 机器人消息：连续同发送者只在最后一条显示头像（Telegram 桌面端分组规则）
            const nextFrom = visibleMessages[index + 1]?.from ?? null;
            const showAvatar = nextFrom !== "bot";
            return (
              <div key={message.id} className={`flex items-end ${showAvatar ? "gap-2" : ""}`}>
                {showAvatar ? (
                  <div className="shrink-0" style={{ width: AVATAR_SIZE }}>
                    <ChatAvatar name={message.sender} size={AVATAR_SIZE} />
                  </div>
                ) : (
                  <div className="shrink-0" style={{ width: AVATAR_SIZE, marginRight: AVATAR_GAP }} />
                )}
                <div className="min-w-0 flex-1">
                  <div className="w-full rounded-2xl rounded-bl-md bg-white px-3 py-2 shadow-sm">
                    {message.loading ? (
                      <LoadingDots />
                    ) : message.content.type !== "text" ? (
                      <MediaBlock content={message.content} />
                    ) : (
                      <>
                        <BubbleTime outgoing={false} time={message.time} />
                        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-[#0f0f0f]">
                          {message.content.text}
                        </p>
                        <span className="clear-both block h-0" />
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 浮动「滚动到底部」圆钮（截图2 右下角） */}
      {showScrollDown ? (
        <button
          type="button"
          onClick={() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })}
          aria-label="滚动到底部"
          className="absolute bottom-[96px] right-6 z-10 flex h-11 w-11 cursor-pointer items-center justify-center rounded-full bg-white text-[#5e6e7e] shadow-[0_2px_10px_rgba(0,0,0,0.2)] transition-opacity hover:text-[#3390ec]"
        >
          <ChevronDown className="h-6 w-6" />
        </button>
      ) : null}

      {/* —— 底部输入区 / 申请加入按钮 —— */}
      {!isPrivate && joinPhase === "idle" ? (
        <div className="px-4 pb-4 lg:px-6">
          <div className="mx-auto w-full max-w-[980px]">
            <button
              type="button"
              onClick={() => void handleJoinClick()}
              disabled={!onRequestJoin || requestingJoin}
              className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-2xl bg-[#3390ec] py-3 text-[15px] font-medium text-white shadow-[0_1px_8px_rgba(0,0,0,0.18)] transition-colors hover:bg-[#2b7cc9] active:bg-[#2470b8] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {requestingJoin ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                  正在申请加入…
                </>
              ) : (
                "申请加入群组"
              )}
            </button>
          </div>
        </div>
      ) : (
        <div className="px-4 pb-4 lg:px-6">
          <div className="mx-auto flex w-full max-w-[980px] items-center gap-2">
            <button
              type="button"
              tabIndex={-1}
              aria-hidden
              className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full text-[#5e6e7e] transition-colors hover:bg-white/50"
            >
              <Paperclip className="h-[22px] w-[22px]" />
            </button>
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-2xl bg-white px-4 py-2.5 shadow-[0_1px_8px_rgba(0,0,0,0.14)]">
              <input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void sendText(input);
                }}
                placeholder={
                  joinPhase === "awaiting_code"
                    ? sending
                      ? "验证中..."
                      : "输入验证码，点击右侧发送按钮..."
                    : onUserSend
                      ? sending
                        ? "发送中..."
                        : "输入消息..."
                      : "输入消息..."
                }
                aria-label="输入消息"
                className="min-w-0 flex-1 bg-transparent text-[15px] text-[#0f0f0f] outline-none placeholder:text-[#9db1c0]"
              />
              <Smile className="h-5 w-5 shrink-0 text-[#9db1c0]" aria-hidden />
            </div>
            <button
              type="button"
              onClick={() => void sendText(input)}
              className={`flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full shadow-[0_1px_6px_rgba(0,0,0,0.16)] transition-colors ${
                input.trim() || joinPhase === "awaiting_code"
                  ? "bg-[#3390ec] text-white hover:bg-[#2b7cc9]"
                  : "bg-white text-[#9db1c0] hover:text-[#5e6e7e]"
              }`}
              aria-label={input.trim() || joinPhase === "awaiting_code" ? "发送" : "录音"}
            >
              {input.trim() || joinPhase === "awaiting_code" ? (
                <SendHorizontal className="h-5 w-5" />
              ) : (
                <Mic className="h-5 w-5" />
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function LoadingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1 text-[#a0adb8]">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#a0adb8]" style={{ animationDelay: "0ms" }} />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#a0adb8]" style={{ animationDelay: "120ms" }} />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#a0adb8]" style={{ animationDelay: "240ms" }} />
    </span>
  );
}
