"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, Paperclip, Search, SendHorizontal, Smile, MoreVertical } from "lucide-react";
import {
  renderMenuTemplate,
  type BotMenuConfig,
  type MenuButton,
  type MenuNode,
} from "@/services/menu-config";

/**
 * TGAPI 申请机器人弹窗仿真屏（v2.1.16）—— 完全独立实现（不复用通用菜单仿真代码）。
 *
 * 仿真链路与真实机器人（src/bot/handlers/tgapi.ts）一一对应：
 * 1. 初始 = 申请加群视图（图1：My Telegram API 群组 + 底部「申请加入群组」按钮）；
 * 2. 点击申请 → 自动通过（真实端 chat_join_request 自动 approve）→ 自动跳转与机器人的
 *    私聊界面 → 机器人发送初始消息 + 内嵌按钮（左侧「消息配置/内嵌按钮配置」实时渲染）；
 * 3. 点「创建API」→ 先检测已创建（门禁前）→ 未解锁时进入验证码验证流程 → 通过后
 *    自动进入创建流程（APP 名称/描述 → 手机号 → 登录码 → api_id/api_hash 结果）；
 * 4. 点「/start 启动机器人」→ 旧消息内嵌按钮过时失效（置灰）→ 重新发送新初始消息；
 * 5. 点「我的API」→ 图2格式（📱 号码 / 🆔 api_id / 🔑 api_hash）；
 * 6. 点「切换语言」→ 中文/English 切换（消息配置双语文案随之切换）。
 */

interface SimButton {
  key: string;
  label: string;
  disabled?: boolean;
  /** 被点击置灰的短暂时值（按压反馈） */
  pressed?: boolean;
}

interface SimMsg {
  id: number;
  from: "bot" | "user" | "system";
  sender: string;
  text: string;
  buttons?: SimButton[];
  /** 按钮所属消息的菜单序号：最新一条菜单消息上的按钮才可用 */
  menuSeq?: number;
  loading?: boolean;
  tone?: "info" | "error";
  time: string;
}

type Phase =
  | "group"
  | "idle"
  | "await_unlock"
  | "await_title"
  | "await_desc"
  | "await_phone"
  | "await_code"
  | "creating";

interface CreatedApp {
  phone: string;
  appId: string;
  apiHash: string;
}

/** 模拟创建成功的 APP 结果（图2格式的示例值，与真实返回同构） */
const DEMO_APP: CreatedApp = {
  phone: "+8618610116610",
  appId: "32434796",
  apiHash: "31ba25a02ad899c5382f1e6b9d8c4a77",
};

const DARK_WALLPAPER: React.CSSProperties = {
  backgroundColor: "#101014",
  backgroundImage: [
    "radial-gradient(circle at 15% 20%, rgba(120,140,255,0.12) 0 18%, transparent 30%)",
    "radial-gradient(circle at 80% 30%, rgba(150,120,255,0.10) 0 16%, transparent 28%)",
    "radial-gradient(circle at 40% 70%, rgba(120,255,190,0.08) 0 20%, transparent 32%)",
    "radial-gradient(circle at 70% 85%, rgba(255,190,120,0.07) 0 14%, transparent 26%)",
    "linear-gradient(160deg, #131318 0%, #0c0c10 55%, #101017 100%)",
  ].join(","),
};

const LIGHT_WALLPAPER: React.CSSProperties = {
  backgroundColor: "#94bd8a",
  backgroundImage: [
    "radial-gradient(circle at 12% 18%, transparent 0 9px, rgba(255,255,255,0.20) 9px 12px, transparent 12px)",
    "radial-gradient(circle at 68% 8%, transparent 0 6px, rgba(255,255,255,0.16) 6px 8px, transparent 8px)",
    "radial-gradient(circle at 84% 32%, transparent 0 11px, rgba(255,255,255,0.18) 11px 14px, transparent 14px)",
    "radial-gradient(circle at 30% 42%, transparent 0 7px, rgba(255,255,255,0.15) 7px 9px, transparent 9px)",
    "linear-gradient(155deg, #a5c996 0%, #8fb886 45%, #97bf8b 100%)",
  ].join(","),
};

function nowTime(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

export interface TgApiMenuSimulatorProps {
  /** 内嵌按钮配置（左侧编辑器实时同步） */
  config: BotMenuConfig;
  /** 消息配置欢迎文案（中英双语实时同步） */
  welcome: { zh: string; en: string };
  /** 机器人展示名（@username 优先） */
  botName: string;
  /** 重置信号：外部「申请加群」按钮点击时 +1，仿真屏恢复申请加群初始状态 */
  resetKey: number;
  /** 申请人自定义 APP 开关（创建流程是否先收集名称/描述，与真实 askAppDetails 一致） */
  askAppDetails: boolean;
  /** APP 默认参数（/skip 提示展示） */
  appDefaults: { title: string; description: string };
}

export function TgApiMenuSimulator({
  config,
  welcome,
  botName,
  resetKey,
  askAppDetails,
  appDefaults,
}: TgApiMenuSimulatorProps) {
  const [phase, setPhase] = useState<Phase>("group");
  const [messages, setMessages] = useState<SimMsg[]>([]);
  const [input, setInput] = useState("");
  const [lang, setLang] = useState<"zh" | "en">("zh");
  const [unlocked, setUnlocked] = useState(false);
  const [created, setCreated] = useState<CreatedApp | null>(null);
  const [sending, setSending] = useState(false);
  const [joinRequesting, setJoinRequesting] = useState(false);
  const menuSeq = useRef(0);
  const nextId = useRef(1);
  const draftPhone = useRef("");
  const draftTitle = useRef("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const textOf = (zh: string, en: string): string => (lang === "zh" ? zh : en);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, phase]);

  /** 外部重置：恢复申请加群初始状态（清空全部会话与模拟状态） */
  useEffect(() => {
    if (resetKey === 0) return;
    setPhase("group");
    setMessages([]);
    setInput("");
    setUnlocked(false);
    setCreated(null);
    setLang("zh");
    menuSeq.current = 0;
    nextId.current = 1;
    draftPhone.current = "";
    draftTitle.current = "";
  }, [resetKey]);

  const append = (message: Omit<SimMsg, "id" | "time">): SimMsg => {
    const entry: SimMsg = { ...message, id: nextId.current++, time: nowTime() };
    setMessages((prev) => [...prev, entry]);
    return entry;
  };

  const patch = (id: number, partial: Partial<SimMsg>): void => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...partial } : m)));
  };

  /** 左侧按钮配置 → 仿真键盘（保留行结构；渲染 {{变量}} 占位符为示例值） */
  const buildKeyboard = (seq: number): SimButton[] => {
    const root: MenuNode = config.root;
    const rows = root.rows.filter((row) => row.buttons.length > 0);
    const buttons: SimButton[] = [];
    rows.forEach((row, rowIndex) => {
      row.buttons.forEach((button, colIndex) => {
        if (rowIndex > 0 || colIndex > 0) {
          // 每行独占：以行号分段展示（仿真键盘逐行渲染，见 renderButtons）
        }
        buttons.push({ key: button.id, label: button.text });
      });
    });
    return buttons;
  };

  /** 发送初始消息（图1：欢迎文案 + 内嵌按钮；每次 seq+1，旧菜单按钮过时失效） */
  const sendStartMessage = (reason?: string): void => {
    const seq = menuSeq.current + 1;
    menuSeq.current = seq;
    const body = renderMenuTemplate(welcome[lang], {
      user_id: "777000",
      username: "preview_user",
      first_name: "预览",
      last_name: "用户",
      chat_id: "-1001998877661",
      chat_title: "My Telegram API",
      message_id: String(1024 + seq),
    });
    if (reason) {
      append({ from: "system", sender: "system", text: reason, tone: "info" });
    }
    append({
      from: "bot",
      sender: botName,
      text: body,
      buttons: buildKeyboard(seq),
      menuSeq: seq,
    });
    setPhase("idle");
  };

  /** 真实 createapi 流程入口（已过门禁）：按 askAppDetails 决定首步（与 tgapi.ts 一致） */
  const beginApplication = (): void => {
    if (askAppDetails) {
      append({
        from: "bot",
        sender: botName,
        text: textOf(
          `📝 请发送你要申请的 APP 名称（App title，1-32 个字符）\n发送 /skip 使用默认：${appDefaults.title}`,
          `📝 Please send the App title (1-32 characters).\nSend /skip to use the default: ${appDefaults.title}`,
        ),
      });
      setPhase("await_title");
      return;
    }
    append({
      from: "bot",
      sender: botName,
      text: textOf(
        "📱 请发送你的 Telegram 手机号（国际格式，如 +8613800138000）",
        "📱 Please send your Telegram phone number in international format, e.g. +14155552671",
      ),
    });
    setPhase("await_phone");
  };

  /** 找回按钮对应的配置按钮（点击时读取 action） */
  const findButton = (key: string): MenuButton | null => {
    for (const row of config.root.rows) {
      for (const button of row.buttons) {
        if (button.id === key) return button;
      }
    }
    return null;
  };

  /** 点击按钮后的完整仿真（与真实 registry.tgapiFuncRunner 语义一致） */
  const pressButton = (msg: SimMsg, button: SimButton): void => {
    if (sending) return;
    if (button.disabled) {
      append({
        from: "system",
        sender: "system",
        text: textOf(
          "此菜单已过期，请发送 /start 获取最新菜单",
          "This menu is outdated. Send /start to get the latest menu.",
        ),
        tone: "info",
      });
      return;
    }
    const configured = findButton(button.key);
    if (!configured) return;
    const action = configured.action;

    if (action.type === "language") {
      const next = lang === "zh" ? "en" : "zh";
      setLang(next);
      append({
        from: "bot",
        sender: botName,
        text:
          next === "zh"
            ? "✅ 语言已切换 / Language switched：中文"
            : "✅ 语言已切换 / Language switched：English",
      });
      return;
    }

    if (action.type === "reply") {
      const raw = action.content?.text || action.text || "";
      append({
        from: "bot",
        sender: botName,
        text:
          renderMenuTemplate(raw, {
            user_id: "777000",
            username: "preview_user",
            first_name: "预览",
            last_name: "用户",
            chat_id: "-1001998877661",
            chat_title: "My Telegram API",
            message_id: "1024",
          }) || textOf("（未配置回复内容）", "(no reply configured)"),
      });
      return;
    }

    if (action.type === "url" || action.type === "web_app") {
      append({
        from: "system",
        sender: "system",
        text: textOf(
          `（URL 按钮：真实 Telegram 将打开 ${action.url ?? "未配置的链接"}）`,
          `(URL button: real Telegram would open ${action.url ?? "an unconfigured link"})`,
        ),
        tone: "info",
      });
      return;
    }

    if (action.type === "tgapi_func") {
      const func = action.tgapi_func ?? "";
      // 按钮级响应配置（中英双语，{{变量}} 渲染）先发
      const response = action.tgapi_response;
      const responseRaw = ((lang === "zh" ? response?.zh : response?.en) ?? "").trim();
      if (responseRaw) {
        append({
          from: "bot",
          sender: botName,
          text: renderMenuTemplate(responseRaw, {
            user_id: "777000",
            username: "preview_user",
            first_name: "预览",
            last_name: "用户",
            chat_id: "-1001998877661",
            chat_title: "My Telegram API",
            message_id: "1024",
          }),
        });
      }
      if (func === "start") {
        // 旧消息内嵌按钮过时失效（真实端：旧键盘被移除；仿真端：置灰并标注）
        setMessages((prev) =>
          prev.map((m) =>
            m.menuSeq !== undefined && m.menuSeq !== menuSeq.current + 1
              ? {
                  ...m,
                  buttons: m.buttons?.map((b) => ({ ...b, disabled: true })),
                }
              : m,
          ),
        );
        sendStartMessage();
        return;
      }
      if (func === "create") {
        // 1. 已创建检测（解锁门禁前）—— 需求5
        if (created) {
          append({
            from: "bot",
            sender: botName,
            text: textOf(
              "✅ 你的 api_id 和 api_hash 已创建，点击下方按钮查看。",
              "✅ Your api_id and api_hash have already been created. Tap the button below to view them.",
            ),
            buttons: [
              { key: "sim-my", label: textOf("💎 我的API", "💎 My API") },
            ],
          });
          return;
        }
        // 2. 解锁门禁（按钮级 tgapi_unlock）—— 需求8
        if (!unlocked && action.tgapi_unlock === true) {
          append({
            from: "bot",
            sender: botName,
            text: textOf(
              "✍🏻 请在下方的输入框进行输入:",
              "✍🏻 Please type in the input field below:",
            ),
          });
          append({
            from: "bot",
            sender: botName,
            text: textOf(
              "🔒 本机器人仅对已解锁用户开放。\n\n首次使用请先解锁：请回复本消息并输入解锁验证码。",
              "🔒 This bot is only available to unlocked users.\n\nFirst time here? Please unlock: reply to this message and send your unlock code.",
            ),
          });
          setPhase("await_unlock");
          return;
        }
        // 3. 已解锁 → 创建API流程
        beginApplication();
        return;
      }
      if (func === "my") {
        if (!created) {
          append({
            from: "bot",
            sender: botName,
            text: textOf(
              "💎 你还没有创建 API。\n\n点击 🗝 创建API 开始申请。",
              "💎 You haven't created an API yet.\n\nTap 🗝 Create API to start.",
            ),
          });
          return;
        }
        // 图2格式
        append({
          from: "bot",
          sender: botName,
          text:
            lang === "zh"
              ? `📱 号码：${created.phone}\n🆔 api_id：${created.appId}\n🔑 api_hash：${created.apiHash}`
              : `📱 Number: ${created.phone}\n🆔 api_id: ${created.appId}\n🔑 api_hash: ${created.apiHash}`,
        });
        return;
      }
      append({
        from: "system",
        sender: "system",
        text: `（未知功能：${func}）`,
        tone: "error",
      });
      return;
    }

    append({
      from: "system",
      sender: "system",
      text: textOf(
        `（${action.type} 类型按钮：真实机器人将按配置执行）`,
        `(${action.type} button: the real bot executes it as configured)`,
      ),
      tone: "info",
    });
  };

  /** 输入框提交：按当前 phase 推进（与真实会话状态机一致）；text 为空时不触发 */
  const sendText = async (rawText: string | null | undefined): Promise<void> => {
    const text = (rawText ?? "").trim();
    if (!text || sending) return;
    append({ from: "user", sender: "我", text });
    setInput("");
    if (text === "/start") {
      // 真实端 /start 指令（需求4）：重新发送一条新的初始消息+内嵌按钮，
      // 之前的消息和内嵌按钮过时失效（旧键盘置灰）—— 与真实端行为一一对应
      setMessages((prev) =>
        prev.map((m) =>
          m.menuSeq !== undefined
            ? { ...m, buttons: m.buttons?.map((b) => ({ ...b, disabled: true })) }
            : m,
        ),
      );
      sendStartMessage();
      return;
    }
    setSending(true);
    const loading = append({ from: "bot", sender: botName, text: "", loading: true });

    const finish = (reply: string): void => {
      patch(loading.id, { loading: false, text: reply });
      setSending(false);
    };

    // 模拟真实处理延时
    await new Promise((resolve) => setTimeout(resolve, 700));

    if (phase === "await_unlock") {
      // 仿真：任意非空验证码核验通过（真实端走外部验证 API 真实核验）
      setUnlocked(true);
      patch(loading.id, {
        loading: false,
        text: textOf("✅ 解锁成功，欢迎使用！", "✅ Unlocked successfully, welcome!"),
      });
      setSending(false);
      beginApplication();
      return;
    }

    if (phase === "await_title") {
      if (text === "/skip") {
        draftTitle.current = "";
        finish(
          textOf(
            `📄 请发送 APP 描述（App description）\n发送 /skip 使用默认：${appDefaults.description}`,
            `📄 Please send the App description.\nSend /skip to use the default: ${appDefaults.description}`,
          ),
        );
        setPhase("await_desc");
        return;
      }
      if (text.length > 32) {
        finish(
          textOf(
            "APP 名称不合法：请输入 1-32 个字符，或发送 /skip 使用默认值。",
            "Invalid App title: 1-32 characters, or /skip for the default.",
          ),
        );
        return;
      }
      draftTitle.current = text;
      finish(
        textOf(
          `📄 请发送 APP 描述（App description）\n发送 /skip 使用默认：${appDefaults.description}`,
          `📄 Please send the App description.\nSend /skip to use the default: ${appDefaults.description}`,
        ),
      );
      setPhase("await_desc");
      return;
    }

    if (phase === "await_desc") {
      finish(
        textOf(
          "📱 请发送你的 Telegram 手机号（国际格式，如 +8613800138000）\n\n任意阶段发送 /start 可重新输入资料",
          "📱 Please send your Telegram phone number in international format, e.g. +14155552671\n\n/start at any stage to re-enter your details",
        ),
      );
      setPhase("await_phone");
      return;
    }

    if (phase === "await_phone") {
      const phone = text.startsWith("+") ? text.replace(/\s+/g, "") : `+${text.replace(/\s+/g, "")}`;
      if (!/^\+\d{8,15}$/.test(phone)) {
        finish(
          textOf(
            "抱歉，输入内容似乎不是有效的手机号",
            "sorry, but the input does not seem to be a valid phone number",
          ),
        );
        return;
      }
      draftPhone.current = phone;
      finish(
        textOf(
          "收到！\n现在请发送你从 Telegram 收到的登录码！\n\n该验证码仅用于从 my.telegram.org 获取 APP ID\n\n任意阶段发送 /start 可重新输入资料",
          "I see!\nnow please send the Telegram code that you received from Telegram!\n\nthis code is only used for the purpose of getting the APP ID from my.telegram.org\n\n/start at any stage to re-enter your details",
        ),
      );
      setPhase("await_code");
      return;
    }

    if (phase === "await_code") {
      // 进度动画：与真实 beforeSuccLogin → 抓取/创建 → 结果 一致
      finish(textOf("已收到验证码，正在抓取页面 ...", "Code received. Scraping web page ..."));
      setPhase("creating");
      const progressId = loading.id;
      await new Promise((resolve) => setTimeout(resolve, 1400));
      const app: CreatedApp = {
        phone: draftPhone.current || DEMO_APP.phone,
        appId: DEMO_APP.appId,
        apiHash: DEMO_APP.apiHash,
      };
      setCreated(app);
      patch(progressId, {
        text:
          lang === "zh"
            ? `<i>Phone Number</i>: <u>${app.phone}</u>\n\n<i>App Configuration</i>\n<b>APP ID</b>: <code>${app.appId}</code>\n<b>API HASH</b>: <code>${app.apiHash}</code>`
            : `<i>Phone Number</i>: <u>${app.phone}</u>\n\n<i>App Configuration</i>\n<b>APP ID</b>: <code>${app.appId}</code>\n<b>API HASH</b>: <code>${app.apiHash}</code>`,
      });
      setPhase("idle");
      setSending(false);
      return;
    }

    // idle：无状态输入 → 与真实「无状态时给明确重入」语义一致
    patch(loading.id, {
      loading: false,
      text: textOf(
        "👇 请使用下方的内嵌按钮操作",
        "👇 Please use the inline buttons below",
      ),
    });
    setSending(false);
  };

  /** 点击「申请加入群组」：申请 → 自动通过 → 自动跳转私聊并接收初始消息（图1） */
  const handleJoinClick = async (): Promise<void> => {
    if (joinRequesting) return;
    setJoinRequesting(true);
    append({
      from: "system",
      sender: "system",
      text: textOf("正在提交入群申请…", "Submitting join request…"),
      tone: "info",
    });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    append({
      from: "system",
      sender: "system",
      text: textOf("申请已通过，你已加入群组", "Request approved, you have joined the group"),
      tone: "info",
    });
    setJoinRequesting(false);
    // 仿真屏自动跳转到与机器人的私聊界面（与真实加群后的用户动线一致）
    await new Promise((resolve) => setTimeout(resolve, 500));
    sendStartMessage(
      textOf(
        "已切换到与机器人的私聊界面",
        "Switched to the private chat with the bot",
      ),
    );
  };

  // ---------------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------------

  const renderButtons = (msg: SimMsg): React.ReactNode => {
    if (!msg.buttons || msg.buttons.length === 0) return null;
    // 逐行渲染：左侧配置的行结构按行拆分（每行一个 flex）
    const rows = config.root.rows.filter((row) => row.buttons.length > 0);
    let index = 0;
    return (
      <div className="mt-[2px] w-full space-y-[2px]">
        {rows.map((row, rowIndex) => (
          <div key={row.id || rowIndex} className="flex gap-[2px]">
            {row.buttons.map((button) => {
              const sim = msg.buttons?.[index];
              index += 1;
              if (!sim) return null;
              return (
                <button
                  key={sim.key}
                  type="button"
                  disabled={sim.disabled}
                  onClick={() => pressButton(msg, sim)}
                  className={`min-w-0 flex-1 truncate rounded-lg px-2 py-2.5 text-center text-sm transition-colors ${
                    sim.disabled
                      ? "cursor-not-allowed bg-black/10 text-[#9aa0a6] line-through decoration-black/30"
                      : "bg-[#ffffff]/90 text-[#1c1e21] hover:bg-white active:bg-black/15"
                  }`}
                  style={{ backdropFilter: "blur(3px)" }}
                  title={sim.disabled ? "已过时失效" : button.text}
                >
                  {sim.label}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    );
  };

  const renderText = (text: string): React.ReactNode => {
    // 仿真屏支持轻量 HTML 标记（<b>/<i>/<u>/<code>），与真实 Telegram HTML 渲染同构
    const html = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/&lt;(\/?)(b|i|u|code)&gt;/g, "<$1$2>");
    return <span dangerouslySetInnerHTML={{ __html: html }} />;
  };

  const isGroup = phase === "group";
  const inputPlaceholder =
    phase === "await_unlock"
      ? textOf("输入解锁验证码，Enter 发送…", "Enter unlock code, press Enter…")
      : phase === "await_title" || phase === "await_desc"
        ? textOf("输入内容，Enter 发送…", "Type your input, press Enter…")
        : phase === "await_phone"
          ? textOf("输入手机号（国际格式），Enter 发送…", "Enter phone number, press Enter…")
          : phase === "await_code"
            ? textOf("输入登录码，Enter 发送…", "Enter login code, press Enter…")
            : sending
              ? textOf("发送中…", "Sending…")
              : textOf("输入消息，Enter 发送…", "Type a message, press Enter…");

  return (
    <div className="flex h-full min-h-[560px] flex-col overflow-hidden rounded-[2rem] border-8 border-[#0c0d10] shadow-2xl">
      {/* 顶栏 */}
      <div
        className="flex items-center gap-3 px-4 py-3"
        style={{
          background: isGroup
            ? "linear-gradient(180deg, rgba(70,80,120,0.5), rgba(70,80,120,0.15))"
            : "linear-gradient(180deg, rgba(90,130,95,0.35), rgba(90,130,95,0.08))",
          backdropFilter: "blur(2px)",
        }}
      >
        {isGroup ? (
          <span className="-ml-1 px-1 text-lg leading-none text-white/90">‹</span>
        ) : (
          <button
            type="button"
            onClick={() => {
              setPhase("group");
              setMessages([]);
              menuSeq.current = 0;
              setUnlocked(false);
              setCreated(null);
            }}
            aria-label="返回申请加群"
            className="-ml-1 cursor-pointer px-1 text-lg leading-none text-white/90 transition-colors hover:text-white"
            title={textOf("返回群组（申请加群）", "Back to group (join request)")}
          >
            ‹
          </button>
        )}
        {isGroup ? (
          <>
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/80 text-base font-bold text-indigo-500">
              M
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.35)]">
                My Telegram API
              </p>
              <p className="text-sm text-white/85 [text-shadow:0_1px_2px_rgba(0,0,0,0.3)]">
                {textOf("3 位成员", "3 members")}
              </p>
            </div>
          </>
        ) : (
          <>
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/80 text-base font-bold text-[#3390ec]">
              {botName.slice(0, 1)}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.35)]">
                {botName}
              </p>
              <p className="text-sm text-white/85 [text-shadow:0_1px_2px_rgba(0,0,0,0.3)]">
                {textOf("机器人 · 私聊", "bot · private chat")}
              </p>
            </div>
          </>
        )}
        <Search className="h-4 w-4 text-white/90" />
        <MoreVertical className="h-4 w-4 text-white/90" />
      </div>

      {/* 消息流 / 群组封面 */}
      <div
        ref={scrollRef}
        style={isGroup ? DARK_WALLPAPER : LIGHT_WALLPAPER}
        className={`flex-1 space-y-2 overflow-y-auto px-3 py-4 ${isGroup ? "flex flex-col" : ""}`}
      >
        {isGroup ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="flex flex-col items-center gap-3 text-center">
              <div className="flex h-24 w-24 items-center justify-center rounded-3xl bg-gradient-to-br from-indigo-400 to-purple-500 text-4xl font-bold text-white shadow-xl">
                M
              </div>
              <div>
                <p className="text-lg font-semibold text-white">My Telegram API</p>
                <p className="text-sm text-white/70">
                  {textOf("3 位成员", "3 members")}
                </p>
              </div>
              <p className="max-w-xs text-xs leading-relaxed text-white/60">
                {textOf(
                  "点击底部「申请加入群组」模拟真实加群申请：机器人自动通过后自动进入与机器人的私聊界面。",
                  "Tap the button below to simulate a real join request: the bot auto-approves and you switch to the private chat automatically.",
                )}
              </p>
            </div>
          </div>
        ) : (
          <>
            {messages.map((message) => {
              if (message.from === "system") {
                return (
                  <div key={message.id} className="flex justify-center py-1">
                    <span
                      className={`rounded-full px-3 py-1 text-center text-xs leading-relaxed ${
                        message.tone === "error"
                          ? "bg-red-900/70 text-white"
                          : "bg-black/25 text-white"
                      }`}
                    >
                      {message.text}
                    </span>
                  </div>
                );
              }
              const outgoing = message.from === "user";
              return (
                <div
                  key={message.id}
                  className={`flex max-w-[86%] flex-col ${
                    outgoing ? "items-end" : "items-start"
                  }`}
                >
                  <div
                    className={`w-full px-3 py-2 shadow-sm ${
                      outgoing
                        ? "rounded-2xl rounded-br-md bg-[#effdde]"
                        : "rounded-2xl rounded-bl-md bg-white"
                    }`}
                  >
                    {!outgoing ? (
                      <p className="mb-0.5 text-sm font-semibold text-[#3390ec]">
                        {message.sender}
                      </p>
                    ) : null}
                    {message.loading ? (
                      <span className="inline-flex items-center gap-1 py-1 text-[#a0adb8]">
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#a0adb8] [animation-delay:0ms]" />
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#a0adb8] [animation-delay:120ms]" />
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#a0adb8] [animation-delay:240ms]" />
                      </span>
                    ) : (
                      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-[#0f0f0f]">
                        {renderText(message.text)}
                      </p>
                    )}
                    {renderButtons(message)}
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
          </>
        )}
      </div>

      {/* 底部：申请按钮 / 输入框 */}
      {isGroup ? (
        <div className="px-3 py-3" style={DARK_WALLPAPER}>
          <button
            type="button"
            onClick={() => void handleJoinClick()}
            disabled={joinRequesting}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#3390ec] py-3 text-[15px] font-medium text-white shadow-sm transition-colors hover:bg-[#2b7cc9] active:bg-[#2470b8] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {joinRequesting ? (
              <>
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                {textOf("正在申请加入…", "Requesting…")}
              </>
            ) : (
              textOf("申请加入群组", "Request to Join Group")
            )}
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 px-3 py-2.5" style={LIGHT_WALLPAPER}>
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-full bg-white px-3 py-2 shadow-sm">
            <Smile className="h-5 w-5 shrink-0 text-[#a0adb8]" />
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  // 仿真屏位于弹窗保存表单内：必须阻止 Enter 的默认提交行为，
                  // 否则按 Enter 发送消息会意外触发表单保存并关闭弹窗。
                  // 读取 DOM 当前值而非 state：React 批处理下 state 闭包可能滞后
                  // 一拍（极快输入后立即回车时读到旧值），DOM 值永远是最新的
                  event.preventDefault();
                  void sendText(event.currentTarget.value);
                }
              }}
              placeholder={inputPlaceholder}
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
            aria-label={textOf("发送", "Send")}
          >
            {input.trim() ? <SendHorizontal className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </button>
        </div>
      )}
    </div>
  );
}
