"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Mic, Paperclip, Pin, Search, SendHorizontal, Smile, MoreVertical } from "lucide-react";
import {
  executeMenuApi,
  renderMenuTemplate,
  type BotMenuConfig,
  type MenuApiConfig,
  type MenuButton,
  type MenuMediaItem,
  type MenuMessageContent,
  type MenuNode,
  type MenuTemplateVars,
} from "@/services/menu-config";

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

// —— 水合安全时钟（useSyncExternalStore）——
// SSR 阶段返回空字符串快照，客户端水合完成后切换为本地时间快照，
// 从根本上避免服务端/客户端时区不一致导致的 Hydration 错误（React 官方推荐模式）。
let clockCache: { minute: number; value: string } = { minute: -1, value: "" };

function subscribeClock(onStoreChange: () => void): () => void {
  const timer = window.setInterval(onStoreChange, 15000);
  return () => window.clearInterval(timer);
}

function getClockSnapshot(): string {
  const now = new Date();
  const minute = now.getHours() * 60 + now.getMinutes();
  if (clockCache.minute !== minute) {
    clockCache = { minute, value: nowTime() };
  }
  return clockCache.value;
}

function getServerClockSnapshot(): string {
  return "";
}

const WALLPAPER_STYLE: React.CSSProperties = {
  backgroundColor: "#94bd8a",
  backgroundImage: [
    "radial-gradient(circle at 12% 18%, transparent 0 9px, rgba(255,255,255,0.20) 9px 12px, transparent 12px)",
    "radial-gradient(circle at 68% 8%, transparent 0 6px, rgba(255,255,255,0.16) 6px 8px, transparent 8px)",
    "radial-gradient(circle at 84% 32%, transparent 0 11px, rgba(255,255,255,0.18) 11px 14px, transparent 14px)",
    "radial-gradient(circle at 30% 42%, transparent 0 7px, rgba(255,255,255,0.15) 7px 9px, transparent 9px)",
    "radial-gradient(circle at 55% 58%, transparent 0 12px, rgba(255,255,255,0.14) 12px 15px, transparent 15px)",
    "radial-gradient(circle at 88% 72%, transparent 0 8px, rgba(255,255,255,0.18) 8px 10px, transparent 10px)",
    "radial-gradient(circle at 18% 78%, transparent 0 10px, rgba(255,255,255,0.16) 10px 13px, transparent 13px)",
    "radial-gradient(circle at 45% 90%, transparent 0 7px, rgba(255,255,255,0.15) 7px 9px, transparent 9px)",
    "radial-gradient(circle at 8% 55%, transparent 0 6px, rgba(255,255,255,0.14) 6px 8px, transparent 8px)",
    "linear-gradient(155deg, #a5c996 0%, #8fb886 45%, #97bf8b 100%)",
  ].join(","),
}

function MediaBlock({
  content,
  albumGrid = true,
}: {
  content: MenuMessageContent;
  albumGrid?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  if (content.type === "photo" && content.mediaUrl) {
    return (
      <div className="space-y-1.5">
        {!failed ? (
          <img
            src={content.mediaUrl}
            alt="图片消息"
            className="max-h-64 w-full rounded-lg object-cover"
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
        <video
          src={content.mediaUrl}
          controls
          playsInline
          muted
          className="max-h-64 w-full rounded-lg bg-black"
        />
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
        <div
          className={`grid overflow-hidden rounded-lg ${
            single || !albumGrid ? "grid-cols-1" : "grid-cols-2 gap-[2px]"
          }`}
        >
          {items.map((item, index) =>
            item.type === "video" ? (
              <video
                key={index}
                src={item.url}
                controls
                playsInline
                muted
                className="h-40 w-full bg-black object-cover"
              />
            ) : (
                  <img key={index} src={item.url} alt="相册图片" className="h-40 w-full object-cover" />
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

function MenuKeyboard({
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
    <div className="mt-[2px] w-full space-y-[2px]">
      {node.rows.map((row, rowIndex) => (
        <div key={row.id || rowIndex} className="flex gap-[2px]">
          {row.buttons.map((button) => (
            <button
              key={button.id || button.text}
              type="button"
              onClick={() => onButtonClick(button)}
              className={`min-w-0 flex-1 truncate rounded-lg px-2 py-2.5 text-center text-sm text-[#1c1e21] transition-colors ${
                pressedId === button.id
                  ? "bg-black/25"
                  : "bg-[#e8ebe3]/55 hover:bg-[#eef1e9]/70 active:bg-black/15"
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

export function TgSimulator({
  config,
  botName,
  groupTitle = "测试群组",
  nodeId,
  onNodeNavigate,
  onApiCall,
  systemNote,
  templateVars,
  promptMessage,
  onUserSend,
  memberCount = "12 位成员",
  joinPhase,
  onRequestJoin,
  view = "group",
}: {
  config: BotMenuConfig;
  botName: string;
  groupTitle?: string;
  nodeId: string;
  onNodeNavigate: (nodeId: string) => void;
  onApiCall?: (api: MenuApiConfig) => Promise<{ ok: boolean; text: string }>;
  /** 顶部提示条文案（默认：菜单预览提示） */
  systemNote?: string;
  /** 覆盖菜单模板变量（如真实的 chat_id / user_id），供机器人测试页传入仿真群组上下文 */
  templateVars?: Partial<MenuTemplateVars>;
  /** 外部注入的机器人消息（如加群验证提示），由父组件控制生命周期 */
  promptMessage?: { id: number; text: string; hint?: string } | null;
  /** 用户发送文本消息的处理器（如提交验证码）；未提供时保持本地回显行为。joined=true 时追加「已加入群组」系统提示 */
  onUserSend?: (text: string) => Promise<{ ok: boolean; text: string; joined?: boolean }>;
  memberCount?: string;
  /** 加群仿真阶段（与真实 Telegram 加群一致）：idle=尚未加入（底部显示「申请加入群组」按钮），awaiting_code/joined=显示输入框。不传则始终显示输入框（菜单预览模式） */
  joinPhase?: "idle" | "awaiting_code" | "joined";
  /** 点击「申请加入群组」按钮时触发（父组件创建加群申请会话）；返回消息在聊天流中以系统胶囊展示 */
  onRequestJoin?: () => Promise<{ ok: boolean; message: string }>;
  /** 当前聊天视图：group=群组聊天（真实加群界面），private=与机器人的私聊（验证码在此输入，隐私模式，群里看不到）。由父组件控制切换 */
  view?: "group" | "private";
}) {
  const history = useRef<string[]>([]);
  const [messages, setMessages] = useState<SimMessage[]>([]);
  // 与机器人的私聊消息流（验证码在此输入，与群组消息完全隔离）
  const [dmMessages, setDmMessages] = useState<SimMessage[]>([]);
  const [input, setInput] = useState("");
  const [pressed, setPressed] = useState<string | null>(null);
  const [requestingJoin, setRequestingJoin] = useState(false);
  const nextId = useRef(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const menuMessageRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // SSR 期间为空字符串，水合完成后显示本地时间 → 消除服务端/客户端时区不一致的水合错误
  const clock = useSyncExternalStore(subscribeClock, getClockSnapshot, getServerClockSnapshot);

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
  const [sending, setSending] = useState(false);
  const isPrivate = view === "private";

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, dmMessages, view, nodeId]);

  /** 向指定消息流追加消息（group=群组聊天，dm=与机器人的私聊） */
  const appendStream = (target: "group" | "dm", message: Omit<SimMessage, "id" | "time">): void => {
    const entry = { ...message, id: nextId.current++, time: nowTime() };
    if (target === "dm") setDmMessages((prev) => [...prev, entry]);
    else setMessages((prev) => [...prev, entry]);
  };

  /** 追加到当前视图的消息流（私聊验证码与群组消息完全隔离） */
  const appendMessage = (message: Omit<SimMessage, "id" | "time">): void => {
    appendStream(isPrivate ? "dm" : "group", message);
  };

  const patchStream = (target: "group" | "dm", id: number, patch: Partial<SimMessage>): void => {
    const setter = target === "dm" ? setDmMessages : setMessages;
    setter((prev) => prev.map((message) => (message.id === id ? { ...message, ...patch } : message)));
  };

  // 进入私聊视图：以系统胶囊说明隐私语义（验证码仅机器人可见，群里看不到）
  useEffect(() => {
    if (view !== "private") return;
    const entry: SimMessage = {
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
    };
    setDmMessages((prev) => [...prev, entry]);
  }, [view]);

  const handleButtonClick = async (button: MenuButton): Promise<void> => {
    if (pressed) return;
    setPressed(button.id);
    setTimeout(() => setPressed(null), 250);

    const action = button.action;
    if (action.type === "submenu") {
      if (button.submenu) {
        history.current.push(nodeId);
        onNodeNavigate(button.id);
      }
      return;
    }
    if (action.type === "back") {
      const target = history.current.pop() ?? "root";
      onNodeNavigate(target);
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
      appendMessage({ from: "bot", sender: botName, content });
      return;
    }
    if (action.type === "api" && action.api) {
      // appendStream 立即分配 id：loading 消息将拿到当前 nextId
      const loadingId = nextId.current;
      appendMessage({
        from: "bot",
        sender: botName,
        content: { type: "text", text: "", mediaUrl: "", items: [] },
        loading: true,
      });
      try {
        const result = onApiCall
          ? await onApiCall(action.api)
          : await executeMenuApi(action.api, vars);
        setMessages((prev) =>
          prev.map((message) =>
            message.id === loadingId
              ? {
                  ...message,
                  loading: false,
                  content: {
                    type: "text",
                    text: result.ok ? result.text : `⚠️ ${result.text}`,
                    mediaUrl: "",
                    items: [],
                  },
                }
              : message,
          ),
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setMessages((prev) =>
          prev.map((message) =>
            message.id === loadingId
              ? {
                  ...message,
                  loading: false,
                  content: { type: "text", text: `⚠️ ${detail}`, mediaUrl: "", items: [] },
                }
              : message,
          ),
        );
      }
    }
  };

  const sendText = async (rawText: string): Promise<void> => {
    const text = rawText.trim();
    if (!text || sending) return;
    const stream: "group" | "dm" = isPrivate ? "dm" : "group";
    appendStream(stream, {
      from: "user",
      sender: "我",
      content: { type: "text", text, mediaUrl: "", items: [] },
    });
    setInput("");
    if (!onUserSend) return;
    // appendStream 立即分配 id：loading 消息将拿到当前 nextId
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
      if (result.ok && result.joined) {
        // 验证通过：回到群组视图后展示入群系统提示（验证码与验证对话只存在于私聊）
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

  /** 点击「申请加入群组」：结果以系统胶囊消息展示（失败红色，成功由机器人提示消息接续） */
  const handleJoinClick = async (): Promise<void> => {
    if (!onRequestJoin || requestingJoin) return;
    setRequestingJoin(true);
    try {
      const result = await onRequestJoin();
      if (!result.ok) {
        appendMessage({
          from: "system",
          sender: "system",
          content: { type: "text", text: `⚠️ ${result.message}`, mediaUrl: "", items: [] },
          tone: "error",
        });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      appendMessage({
        from: "system",
        sender: "system",
        content: { type: "text", text: `⚠️ ${detail}`, mediaUrl: "", items: [] },
        tone: "error",
      });
    } finally {
      setRequestingJoin(false);
    }
  };

  const totalButtons = currentNode.rows.reduce((sum, row) => sum + row.buttons.length, 0);
  const isRoot = nodeId === "root";

  return (
    <div className="flex h-full min-h-[560px] flex-col overflow-hidden rounded-[2rem] border-8 border-[#0c0d10] shadow-2xl">
      <div
        className="flex items-center gap-3 px-4 py-3"
        style={{ background: "linear-gradient(180deg, rgba(90,130,95,0.35), rgba(90,130,95,0.08))", backdropFilter: "blur(2px)" }}
      >
        <span className="text-sm text-white/90">‹</span>
        {isPrivate ? (
          <>
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/80 text-base font-bold text-[#3390ec]">
              {botName.slice(0, 1)}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.35)]">
                {botName}
              </p>
              <p className="text-sm text-white/85 [text-shadow:0_1px_2px_rgba(0,0,0,0.3)]">机器人 · 私聊（验证码仅双方可见）</p>
            </div>
          </>
        ) : (
          <>
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/80 text-sm font-bold text-[#4a7a52]">
              {groupTitle.slice(0, 1)}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.35)]">
                {groupTitle}
              </p>
              <p className="text-sm text-white/85 [text-shadow:0_1px_2px_rgba(0,0,0,0.3)]">{memberCount}</p>
            </div>
          </>
        )}
        <Search className="h-4 w-4 text-white/90" />
        <MoreVertical className="h-4 w-4 text-white/90" />
      </div>

      {!isPrivate ? (
        <button
          type="button"
          onClick={() => menuMessageRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })}
          className="flex items-center gap-2 border-b border-black/5 bg-white/80 px-4 py-2 text-left backdrop-blur-sm"
        >
          <Pin className="h-4 w-4 shrink-0 rotate-45 text-[#3390ec]" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-[#3390ec]">置顶消息</p>
            <p className="truncate text-sm text-[#3b4a54]">
              {config.content.text || "（菜单消息）"} · {isRoot ? "主菜单" : "子菜单"}（{totalButtons} 个按钮）
            </p>
          </div>
        </button>
      ) : null}

      <div ref={scrollRef} style={WALLPAPER_STYLE} className="flex-1 space-y-2 overflow-y-auto px-3 py-4">
        <div className="flex justify-center py-1">
          <span className="rounded-full bg-black/25 px-3 py-1 text-sm text-white">
            {systemNote ?? "机器人已就绪，下方为消息内嵌按钮实时预览"}
          </span>
        </div>

        {isPrivate && promptMessage ? (
          <div className="flex max-w-[86%] flex-col items-start">
            <div className="w-full rounded-2xl rounded-bl-md border-l-4 border-[#3390ec] bg-white px-3 py-2 shadow-sm">
              <p className="mb-0.5 text-sm font-semibold" style={{ color: nameColor(botName) }}>
                {botName}
              </p>
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-[#0f0f0f]">
                {promptMessage.text}
              </p>
              {promptMessage.hint ? (
                <p className="mt-1 rounded-md bg-[#3390ec]/10 px-2 py-1 text-sm font-medium text-[#3390ec]">
                  ↩︎ {promptMessage.hint}
                </p>
              ) : null}
            </div>
            <p className="mt-0.5 text-sm text-[#3b4a54]/70">{clock}</p>
          </div>
        ) : null}

        {!isPrivate ? (
          <div className="flex max-w-[86%] flex-col items-start">
            <div
              ref={menuMessageRef}
              className="w-full rounded-2xl rounded-bl-md bg-white px-3 py-2 shadow-sm"
            >
              <p className="mb-0.5 text-sm font-semibold" style={{ color: nameColor(botName) }}>
                {botName}
              </p>
              {config.content.type === "text" ? (
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-[#0f0f0f]">
                  {config.content.text}
                </p>
              ) : (
                <MediaBlock content={config.content} />
              )}
            </div>
            <MenuKeyboard node={currentNode} pressedId={pressed} onButtonClick={handleButtonClick} />
            <p className="mt-0.5 text-right text-sm text-white/95 [text-shadow:0_1px_2px_rgba(0,0,0,0.35)]">
              {clock}
            </p>
          </div>
        ) : null}

        {(isPrivate ? dmMessages : messages).map((message) => {
          if (message.from === "system") {
            return (
              <div key={message.id} className="flex justify-center py-1">
                <span
                  className={`rounded-full px-3 py-1 text-center text-xs leading-relaxed ${
                    message.tone === "error" ? "bg-red-900/70 text-white" : "bg-black/25 text-white"
                  }`}
                >
                  {message.content.text}
                </span>
              </div>
            );
          }
          const outgoing = message.from === "user";
          const hasMedia = message.content.type !== "text";
          return (
            <div key={message.id} className={`flex max-w-[86%] flex-col ${outgoing ? "items-end" : "items-start"}`}>
              <div
                className={`w-full px-3 py-2 shadow-sm ${
                  outgoing ? "rounded-2xl rounded-br-md bg-[#effdde]" : "rounded-2xl rounded-bl-md bg-white"
                }`}
              >
                {!outgoing ? (
                  <p className="mb-0.5 text-sm font-semibold" style={{ color: nameColor(message.sender) }}>
                    {message.sender}
                  </p>
                ) : null}
                {message.loading ? (
                  <span className="inline-flex items-center gap-1 py-1 text-[#a0adb8]">
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#a0adb8] [animation-delay:0ms]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#a0adb8] [animation-delay:120ms]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#a0adb8] [animation-delay:240ms]" />
                  </span>
                ) : hasMedia ? (
                  <MediaBlock content={message.content} />
                ) : (
                  <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-[#0f0f0f]">
                    {message.content.text}
                  </p>
                )}
              </div>
              <p
                className={`mt-0.5 text-right text-sm ${
                  outgoing ? "text-[#4f8a55]" : "text-[#3b4a54]/70"
                }`}
              >
                {message.time}
                {outgoing ? " ✓✓" : ""}
              </p>
            </div>
          );
        })}
      </div>

      {!isPrivate && joinPhase === "idle" ? (
        <div className="px-3 py-3" style={WALLPAPER_STYLE}>
          <button
            type="button"
            onClick={() => void handleJoinClick()}
            disabled={!onRequestJoin || requestingJoin}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#3390ec] py-3 text-[15px] font-medium text-white shadow-sm transition-colors hover:bg-[#2b7cc9] active:bg-[#2470b8] disabled:cursor-not-allowed disabled:opacity-60"
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
      ) : (
        <div className="flex items-center gap-2 px-3 py-2.5" style={WALLPAPER_STYLE}>
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-full bg-white px-3 py-2 shadow-sm">
            <Smile className="h-5 w-5 shrink-0 text-[#a0adb8]" />
            <input
              ref={inputRef}
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
                      : "输入消息，Enter 发送..."
                    : "写消息..."
              }
              className="min-w-0 flex-1 bg-transparent text-sm text-[#0f0f0f] outline-none placeholder:text-[#a0adb8]"
            />
            <Paperclip className="h-4 w-4 shrink-0 text-[#a0adb8]" />
          </div>
          <button
            type="button"
            onClick={() => void sendText(input)}
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full shadow-sm transition-colors ${
              input.trim() ? "bg-[#3390ec] text-white" : "bg-white text-[#a0adb8]"
            }`}
            aria-label="发送"
          >
            {input.trim() || joinPhase === "awaiting_code" ? (
              <SendHorizontal className="h-4 w-4" />
            ) : (
              <Mic className="h-4 w-4" />
            )}
          </button>
        </div>
      )}
    </div>
  );
}
