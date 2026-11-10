"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { TgSimulator, type TgSimulatorHandle } from "@/components/admin/tg-simulator";
import type {
  CustomKeyboardButton,
  CustomKeyboardConfig,
} from "@/services/custom-keyboard";
import { TGAPI_PLATFORM_SUBMENU_ROWS } from "@/services/custom-keyboard";
import {
  isValidTgApiPlatformValue,
  renderMenuTemplate,
  TGAPI_PLATFORM_LABELS,
  type MenuButtonAction,
} from "@/services/menu-config";
import {
  renderTgApiTextTemplate,
  resolveTgApiTexts,
  TGAPI_SYSTEM_TEXTS,
  type TgApiBotConfig,
  type TgApiLang,
} from "@/services/tgapi-config";
import {
  buildAppResultHTML,
  extractPhoneNumber,
  extractTgWebLoginCode,
} from "@/services/tgapi-flow-text";

/**
 * TGAPI 自定义键盘对话流程仿真（v2.2.2；v2.2.7 入口门禁同步）：
 *
 * 与运行端 bot/handlers/tgapi-conversation.ts（@grammyjs/conversations）逐段对应的
 * 客户端状态机 —— 保证「部署后在 APP 中的展现界面和交互逻辑跟仿真屏完全一致」：
 *
 *   /start → 【入口门禁】门禁已配置且未验证：固定的可配置信息内容（unlockPrompt）
 *            + 内嵌按钮（gateButton）→ 点击按钮 → 输码提示（unlockCodePrompt）
 *            → 外部 API 真实核验 → 通过后调起主键盘
 *          → 点击键盘按钮（= 发送文本）→ 动作分发
 *            【通用门禁中间件步】按钮声明 tgapi_unlock 且未解锁 → 门禁
 *           （captcha=输码真实外部核验 / stars=发票+支付；配置缺失绝不放行）
 *          → 🗝 创建API：已创建检测 → 手机号（request_contact）→ 登录码（键盘移除）
 *            → my.telegram.org 抓取/创建（APP 参数 = 预配置 > 默认，平台随机）→ 结果
 *          → 🗂 我的API / 📱 设置平台 / ✅ 语言 / 🆘 帮助 / 🎫 客服支持 /
 *            ✏️ 设置Title / 📝 设置Description
 *          → 任意阶段 /start 重入（未解锁仍先过门禁）
 *
 * v2.2.7 与运行端同步变更：门禁升级为入口门禁（门禁已配置即启用）；门禁消息
 * 新增内嵌按钮（仿真以系统提示模拟点击）；/start 重入未解锁仍先过门禁。
 *
 * 文案与流程分派全部复用运行端同一来源：resolveTgApiTexts / TGAPI_SYSTEM_TEXTS /
 * 按钮槽位（tgapi_response/success/fail）/ buildAppResultHTML / extractTgWebLoginCode /
 * extractPhoneNumber（键入手机号按真实 Telegram 行为补 phone_number 实体）。
 * 仅「外部 API 核验 / my.telegram.org 登录抓取」两处以明确的仿真演示值代替（无法在浏览器真连）。
 *
 * 渲染态（语言/平台/键盘模式）用 state；流程态（stage/unlocked/收集值）用 ref —— 仅在
 * 事件回调与定时器中读写（react-hooks/refs 合规），不参与渲染。
 */

/** 门禁是否启用（与运行端 isTgApiGateConfigured 同一规则；该模块含服务端依赖不可导入客户端） */
function gateConfigured(cfg: TgApiBotConfig): boolean {
  if (cfg.unlockMode === "captcha") return Boolean(cfg.verificationMethodId);
  return (cfg.starsAmount ?? 0) >= 1;
}

/** TGAPI 固定指令 → 功能名映射（与运行端 COMMAND_FUNC_MAP 一致；/skip 已移除） */
const COMMAND_FUNC_MAP: Record<string, string> = {
  "/start": "start",
  "/createapi": "create",
  "/myapi": "my",
  "/setplatform": "platform",
  "/language": "language",
  "/help": "help",
  "/support": "support",
  "/settitle": "settitle",
  "/setdescription": "setdescription",
};

type KbStage =
  | "idle" // 空聊天：等待 /start
  | "menu" // 主键盘：按钮 / 固定指令 / 未知输入
  | "gateCaptcha" // 门禁：等待解锁验证码（通过后执行 pending 按钮功能）
  | "gateStars" // 门禁：等待 Stars 支付（仿真自动支付）
  | "createPhone" // 创建API：手机号（request_contact 键盘）
  | "createCode" // 创建API：登录码（键盘已移除）
  | "prefTitle" // 设置Title 收集
  | "prefDesc" // 设置Description 收集
  | "platformPick"; // 设置平台：平台键盘选择

interface KbFlow {
  stage: KbStage;
  unlocked: boolean;
  prefTitle: string;
  prefDesc: string;
  phone: string;
  created: { phone: string; apiId: string; apiHash: string } | null;
  /** 门禁通过后待执行的按钮功能（通用门禁中间件步的续接） */
  pendingFunc?: string;
  pendingAction?: MenuButtonAction;
  pendingSuccess?: { zh: string; en: string };
  pendingFail?: { zh: string; en: string };
  pendingPrefSuccess?: { zh: string; en: string };
}

/** 仿真演示值（明确标注仿真；MTProto DC 为 Telegram 公开常量） */
const SIM_DEMO_PHONE = "+8613800138000";
const SIM_DEMO_INFO = {
  appId: "2049583",
  apiHash: "b6f1d4e2a9c8372f5d0e1a4b8c7d6e5f",
  productionConfiguration: { ip: "149.154.167.50", dc: "2" },
  testConfiguration: { ip: "149.154.167.40", dc: "2" },
};

function htmlToPlainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/** 真实 Telegram 客户端会把手机号文本自动识别为 phone_number 实体；仿真输入补同款实体 */
function simulatePhoneEntities(text: string): { type: "phone_number"; offset: number; length: number }[] {
  const match = text.match(/(?<!\d)\+?\d{7,15}(?!\d)/);
  if (!match || match.index === undefined) return [];
  return [{ type: "phone_number", offset: match.index, length: match[0].length }];
}

/** 双语槽位文案取值（优先当前语言，为空回落另一语言；与运行端 slotText 一致） */
function slotText(template: { zh: string; en: string } | undefined, lang: TgApiLang): string {
  if (!template) return "";
  return (
    (lang === "zh" ? template.zh : template.en).trim() ||
    (lang === "zh" ? template.en : template.zh).trim()
  );
}

type KbMode = "none" | "main" | "contact" | "platform";

export function TgApiKeyboardFlowSim({
  cfg,
  keyboard,
  botName,
}: {
  cfg: TgApiBotConfig;
  /** 当前编辑中的自定义键盘（随左侧配置实时同步） */
  keyboard: CustomKeyboardConfig;
  botName: string;
}) {
  const simRef = useRef<TgSimulatorHandle>(null);
  const flowRef = useRef<KbFlow>({
    stage: "idle",
    unlocked: false,
    prefTitle: "",
    prefDesc: "",
    phone: "",
    created: null,
  });
  // 渲染态：语言 / 已选平台 / 底部键盘（事件回调中经 setState 更新）
  const [lang, setLang] = useState<TgApiLang>("zh");
  const [platform, setPlatform] = useState("");
  const [kbMode, setKbMode] = useState<KbMode>("none");

  const append = (from: "bot" | "user" | "system", text: string): number =>
    simRef.current?.appendMessage("dm", { from, text }) ?? 0;
  const sys = (): (typeof TGAPI_SYSTEM_TEXTS)[TgApiLang] => TGAPI_SYSTEM_TEXTS[lang];
  const texts = () => resolveTgApiTexts(cfg, lang);

  /** 主键盘消息（对应运行端 sendMenu：start 文案 + 主键盘 markup） */
  const sendMenu = (): void => {
    append("bot", texts().start);
    setKbMode("main");
  };

  /** 按钮槽位模板消息（{{变量}} 按仿真上下文解析；空模板不发送，对应 replyTemplate） */
  const replyTemplate = (
    template: { zh: string; en: string } | undefined,
    fallback: string,
    extraVars: Record<string, unknown> = {},
  ): void => {
    const raw = slotText(template, lang) || fallback;
    if (!raw.trim()) return;
    append(
      "bot",
      renderMenuTemplate(raw, {
        user_id: "777000",
        username: "preview_user",
        first_name: "预览",
        chat_id: "777000",
        ...extraVars,
      }),
    );
  };

  // ---------------------------------------------------------------------------
  // 门禁（tgapi-gate 通用组件仿真形态：captcha 输码 / stars 支付；配置缺失绝不放行）
  // v2.2.7：门禁消息 = 固定的可配置信息内容（unlockPrompt）+ 内嵌按钮（gateButton）；
  // 仿真无法点击真实内嵌按钮，以系统提示模拟点击 → 点击后进入输码提示/发票支付。
  // ---------------------------------------------------------------------------

  /** 门禁入口（per-button tgapi_unlock 续接或 /start 入口门禁）：发门禁消息+按钮 → 输码/发票 */
  const startGate = (func: string | undefined, action: MenuButtonAction | undefined): void => {
    const flow = flowRef.current;
    flow.pendingFunc = func;
    flow.pendingAction = action;
    if (cfg.unlockMode === "captcha") {
      flow.stage = "gateCaptcha";
      setKbMode("none");
      append("bot", texts().unlockPrompt);
      append("system", `（点击消息下方「${texts().gateButton}」按钮开始验证）`);
      append("bot", texts().unlockCodePrompt);
      return;
    }
    const amount = cfg.starsAmount ?? 0;
    if (amount < 1) {
      // 运行端：金额未配置 → 绝不放行也绝不解锁
      flow.stage = "menu";
      append("bot", sys().starsNotConfigured);
      return;
    }
    flow.stage = "gateStars";
    setKbMode("none");
    append("bot", texts().unlockPrompt);
    append("system", `（点击消息下方「${texts().gateButton}」按钮开始验证）`);
    const title = (cfg.starsTitle?.trim() || "TGAPI 解锁").slice(0, 32);
    append(
      "bot",
      `🧾 ${title}\n首次使用 TGAPI 申请机器人前的一次性解锁\n💰 ${amount} ⭐（Telegram Stars）`,
    );
    append("bot", sys().starsInvoiceHint(String(amount)));
    window.setTimeout(() => {
      append("system", "💳 已完成 Stars 支付（仿真演示：真实端为 Telegram 原生支付面板）");
      const flowNow = flowRef.current;
      flowNow.unlocked = true;
      runAfterGate();
    }, 1200);
  };

  /** 门禁通过后续接（per-button = 执行按钮功能；入口门禁 = 调起自定义键盘） */
  const runAfterGate = (): void => {
    const flow = flowRef.current;
    const func = flow.pendingFunc;
    const action = flow.pendingAction;
    flow.pendingFunc = undefined;
    flow.pendingAction = undefined;
    flow.stage = "menu";
    if (func) {
      dispatchFunc(func, action);
      return;
    }
    // 入口门禁通过 → 调起自定义键盘（与运行端 showMenu = true → sendMenu 一致）
    sendMenu();
  };

  /** /start 重入（对应运行端 restart：清创建中间态 → 未解锁仍先过入口门禁 → 主键盘） */
  const restart = (): void => {
    const flow = flowRef.current;
    flow.phone = "";
    flow.pendingSuccess = undefined;
    flow.pendingFail = undefined;
    flow.pendingFunc = undefined;
    flow.pendingAction = undefined;
    flow.pendingPrefSuccess = undefined;
    if (gateConfigured(cfg) && !flow.unlocked) {
      startGate(undefined, undefined);
      return;
    }
    flow.stage = "menu";
    sendMenu();
  };

  /** 对话入口（/start：门禁已配置且未验证 → 先入口门禁；通过后调起主键盘） */
  const startConversation = (): void => {
    const flow = flowRef.current;
    if (gateConfigured(cfg) && !flow.unlocked) {
      startGate(undefined, undefined);
      return;
    }
    flow.stage = "menu";
    sendMenu();
  };

  /** 创建API：手机号（request_contact 键盘；对应运行端 runCreateFlow 第 3 步） */
  const startPhone = (): void => {
    const flow = flowRef.current;
    flow.stage = "createPhone";
    append("bot", texts().askPhone);
    setKbMode("contact");
  };

  /** 创建API：登录码提交 → 登录 → 抓取/创建 → 结果（对应运行端第 4 步；登录为仿真演示值） */
  const submitLoginCode = (): void => {
    const flow = flowRef.current;
    flow.stage = "menu";
    const progressId = append("bot", texts().beforeSuccLogin);
    window.setTimeout(() => {
      const flowNow = flowRef.current;
      const phone = flowNow.phone || SIM_DEMO_PHONE;
      flowNow.created = { phone, apiId: SIM_DEMO_INFO.appId, apiHash: SIM_DEMO_INFO.apiHash };
      simRef.current?.patchMessage("dm", progressId, {
        text:
          htmlToPlainText(buildAppResultHTML(phone, SIM_DEMO_INFO)) +
          (cfg.footerText ? `\n\n${cfg.footerText}` : "") +
          "\n\n（仿真演示数据；真实端登录 my.telegram.org 抓取/创建后返回真实值）",
      });
      // 收尾单条消息：成功模板（配置时）或主键盘菜单消息，随主键盘一并重新显示
      const successRaw = slotText(flowNow.pendingSuccess, lang);
      if (successRaw) {
        replyTemplate(flowNow.pendingSuccess, "", {
          phone,
          api_id: SIM_DEMO_INFO.appId,
          api_hash: SIM_DEMO_INFO.apiHash,
        });
        setKbMode("main");
      } else {
        append("bot", texts().start);
        setKbMode("main");
      }
      flowNow.stage = "menu";
    }, 1200);
  };

  /** 按钮功能执行（对应运行端 switch 分派；门禁已在分发层完成） */
  const dispatchFunc = (func: string, action: MenuButtonAction | undefined): void => {
    const flow = flowRef.current;
    if (func === "start") {
      restart();
      return;
    }
    if (func === "create") {
      if (action?.tgapi_response) replyTemplate(action.tgapi_response, "");
      if (flow.created) {
        replyTemplate(undefined, texts().alreadyCreated);
        return;
      }
      flow.pendingSuccess = action?.tgapi_success;
      flow.pendingFail = action?.tgapi_fail;
      startPhone();
      return;
    }
    if (func === "my") {
      if (!flow.created) {
        replyTemplate(action?.tgapi_fail, texts().myApiEmpty);
        return;
      }
      replyTemplate(
        action?.tgapi_success,
        texts().myApiResult,
        {
          phone: flow.created.phone,
          api_id: flow.created.apiId,
          api_hash: flow.created.apiHash,
        },
      );
      return;
    }
    if (func === "platform") {
      const value = action?.tgapi_value ?? "";
      if (value && isValidTgApiPlatformValue(value)) {
        setPlatform(value);
        const label = TGAPI_PLATFORM_LABELS[value] ?? value;
        replyTemplate(action?.tgapi_success, texts().platformSet, { platform: label });
        return;
      }
      // 入口按钮：切换到平台键盘（每行 2 个共 8 个平台按钮 + 返回）
      flow.stage = "platformPick";
      append("bot", texts().askPlatform);
      setKbMode("platform");
      return;
    }
    if (func === "language") {
      const next: TgApiLang = lang === "zh" ? "en" : "zh";
      setLang(next);
      append("bot", TGAPI_SYSTEM_TEXTS[next].languageHelp(next));
      return;
    }
    if (func === "help") {
      replyTemplate(action?.tgapi_response, texts().helpText);
      return;
    }
    if (func === "support") {
      replyTemplate(action?.tgapi_response, texts().supportText);
      return;
    }
    if (func === "settitle" || func === "setdescription") {
      if (action?.tgapi_response) {
        replyTemplate(action.tgapi_response, "");
      } else {
        append(
          "bot",
          renderTgApiTextTemplate(
            func === "settitle" ? texts().askAppTitle : texts().askAppDescription,
            func === "settitle" ? cfg.appTitle : cfg.appDescription,
          ),
        );
      }
      flow.stage = func === "settitle" ? "prefTitle" : "prefDesc";
      flow.pendingPrefSuccess = action?.tgapi_success;
      return;
    }
    append("bot", `⚠️ 未知的 TGAPI 功能：${func}`);
  };

  /** 主键盘分派（对应运行端动作分发循环：按钮文本映射优先，其次固定指令 → 门禁中间件步） */
  const dispatchMenuAction = (text: string): void => {
    const flow = flowRef.current;
    let matched: CustomKeyboardButton | undefined;
    for (const row of keyboard.root.rows) {
      for (const button of row.buttons) {
        if (button.kind === "text" && button.text.trim() === text) matched = button;
      }
    }
    let func: string | null = null;
    let action: MenuButtonAction | undefined;
    if (matched?.action) {
      if (matched.action.type === "tgapi_func") {
        func = matched.action.tgapi_func ?? "start";
        action = matched.action;
      } else if (matched.action.type === "language") {
        func = "language";
      }
      // reply/command 等键盘动作 = 用户自定义，TGAPI 对话流程不处理（与运行端一致 → 未知输入提示）
    } else {
      func = COMMAND_FUNC_MAP[text] ?? null;
    }
    if (!func) {
      append("bot", texts().unknownInputHint);
      return;
    }
    // —— 通用门禁中间件步（对应运行端 tgapi_unlock 检查）：声明门禁且未解锁 → 先过门禁 ——
    if (action?.tgapi_unlock === true && !flow.unlocked) {
      startGate(func, action);
      return;
    }
    flow.stage = "menu";
    dispatchFunc(func, action);
  };

  /** 私聊输入统一漏斗（对应运行端各 conversation.wait 分支） */
  const handleInput = (rawText: string, contactPhone: string | null): void => {
    const flow = flowRef.current;
    const text = rawText.trim();

    if (flow.stage === "idle") {
      if (text === "/start") startConversation();
      else append("bot", texts().unknownInputHint);
      return;
    }
    if (flow.stage === "gateCaptcha") {
      if (!text) return;
      if (text === "/start") {
        restart();
        return;
      }
      // 运行端走外部 API 真实核验；仿真：任意非空验证码通过（界面文案一致）
      flow.unlocked = true;
      flow.stage = "menu";
      const func = flow.pendingFunc;
      const action = flow.pendingAction;
      flow.pendingFunc = undefined;
      flow.pendingAction = undefined;
      if (func) {
        dispatchFunc(func, action);
        return;
      }
      // 入口门禁通过 → 调起自定义键盘
      sendMenu();
      return;
    }
    if (flow.stage === "gateStars") {
      if (text === "/start") {
        restart();
        return;
      }
      append("bot", sys().starsInvoicePending);
      return;
    }
    if (flow.stage === "menu") {
      if (contactPhone) {
        replyTemplate(undefined, texts().contactAtMenu);
        return;
      }
      dispatchMenuAction(text);
      return;
    }
    if (flow.stage === "createPhone") {
      const cancelLabel = texts().cancelLabel;
      if (text === "/start") {
        restart();
        return;
      }
      if (text === cancelLabel) {
        // 运行端 return "done" → 回到主键盘等待（request_contact 为 one_time，点击后键盘隐藏）
        flow.stage = "menu";
        setKbMode("none");
        return;
      }
      const candidate = extractPhoneNumber(rawText, simulatePhoneEntities(rawText), contactPhone);
      if (!candidate) {
        append("bot", texts().invalidPhone);
        return;
      }
      flow.phone = candidate;
      flow.stage = "createCode";
      append("bot", texts().afterRecvdCode);
      setKbMode("none");
      return;
    }
    if (flow.stage === "createCode") {
      if (text === "/start") {
        restart();
        return;
      }
      const providedCode = extractTgWebLoginCode(rawText);
      if (!providedCode) {
        append("bot", texts().invalidCode);
        return;
      }
      submitLoginCode();
      return;
    }
    if (flow.stage === "prefTitle" || flow.stage === "prefDesc") {
      const isTitle = flow.stage === "prefTitle";
      if (text === "/start") {
        restart();
        return;
      }
      if (!text || text.length > (isTitle ? 32 : 200)) {
        append("bot", isTitle ? sys().titleInvalid : sys().descriptionInvalid);
        return;
      }
      if (isTitle) flow.prefTitle = text;
      else flow.prefDesc = text;
      replyTemplate(
        flow.pendingPrefSuccess,
        isTitle ? texts().titleSet : texts().descriptionSet,
        isTitle ? { title: text } : { description: text },
      );
      flow.stage = "menu";
      return;
    }
    if (flow.stage === "platformPick") {
      const backLabel = lang === "zh" ? "← 返回主键盘" : "← Back";
      if (text === "/start") {
        restart();
        return;
      }
      const pickText = text.replace(/^✅\s*/, "");
      if (pickText === backLabel || pickText === "/setplatform") {
        flow.stage = "menu";
        sendMenu();
        return;
      }
      const matched = Object.entries(TGAPI_PLATFORM_LABELS).find(([, label]) => label === pickText);
      if (!matched) {
        append("bot", texts().unknownInputHint);
        return;
      }
      setPlatform(matched[0]);
      // 单条消息：设置确认随主键盘一并重新显示（平台键盘为 one_time，选中后关闭）
      append(
        "bot",
        renderMenuTemplate(texts().platformSet, {
          user_id: "777000",
          username: "preview_user",
          first_name: "预览",
          chat_id: "777000",
          platform: matched[1],
        }),
      );
      flow.stage = "menu";
      setKbMode("main");
      return;
    }
  };

  /** 键盘按钮点击 = 用户发送按钮文本（request_contact = 发送联系人，web_app = 打开页面） */
  const handleReplyClick = (button: CustomKeyboardButton): void => {
    if (button.kind === "web_app") {
      if (button.url) window.open(button.url, "_blank", "noopener");
      return;
    }
    if (button.kind === "request_contact") {
      append("user", `📱 ${SIM_DEMO_PHONE}（联系人卡片）`);
      handleInput("", SIM_DEMO_PHONE);
      return;
    }
    append("user", button.text);
    handleInput(button.text, null);
  };

  /** 输入框发送（文本消息；联系人只经键盘按钮产生） */
  const handleSend = async (text: string): Promise<{ ok: boolean; text: string }> => {
    handleInput(text, null);
    return { ok: true, text: "" };
  };

  // 当前展示的底部键盘（none=已移除；contact/platform=流程切换的临时键盘）
  const replyKeyboard = useMemo<CustomKeyboardConfig | undefined>(() => {
    if (kbMode === "main") return keyboard;
    if (kbMode === "contact") {
      const shareLabel = texts().shareContactLabel;
      const cancelLabel = texts().cancelLabel;
      return {
        options: { resize: true, persistent: false, oneTime: true, inputPlaceholder: "" },
        root: {
          rows: [
            {
              id: "sim-kbrow-contact",
              buttons: [
                { id: "sim-kbtn-contact", text: shareLabel, kind: "request_contact", style: "primary" },
              ],
            },
            {
              id: "sim-kbrow-cancel",
              buttons: [{ id: "sim-kbtn-cancel", text: cancelLabel, kind: "text", style: "default" }],
            },
          ],
        },
      };
    }
    if (kbMode === "platform") {
      const backLabel = lang === "zh" ? "← 返回主键盘" : "← Back";
      return {
        options: { resize: true, persistent: false, oneTime: true, inputPlaceholder: "" },
        root: {
          rows: [
            ...TGAPI_PLATFORM_SUBMENU_ROWS.map((pair, index) => ({
              id: `sim-kbrow-platform-${index}`,
              buttons: pair.map((item) => ({
                id: `sim-kbtn-platform-${item}`,
                text: `${platform === item ? "✅ " : ""}${TGAPI_PLATFORM_LABELS[item] ?? item}`,
                kind: "text" as const,
                style: "default" as const,
              })),
            })),
            {
              id: "sim-kbrow-back",
              buttons: [{ id: "sim-kbrow-back-btn", text: backLabel, kind: "text" as const, style: "default" as const }],
            },
          ],
        },
      };
    }
    return undefined;
  }, [kbMode, keyboard, lang, platform]);

  // 弹窗每次挂载：空聊天 + 启动指引（与真实部署一致：私聊发送 /start 才启动）
  useEffect(() => {
    simRef.current?.appendMessage("dm", {
      from: "system",
      text: "私聊对话仿真（与部署后真实行为一致）：输入 /start 启动机器人 → 门禁验证（已配置时）→ 主键盘 → 按钮交互",
    });
  }, []);

  return (
    <TgSimulator
      ref={simRef}
      config={{ content: { type: "text", text: "", mediaUrl: "", items: [] }, root: { rows: [] } }}
      botName={botName}
      view="private"
      nodeId="root"
      onNodeNavigate={() => undefined}
      systemNote="TGAPI 对话流程仿真 · /start 启动后与真实部署完全一致"
      onUserSend={handleSend}
      silentUserSend
      replyKeyboard={replyKeyboard}
      onReplyButtonClick={handleReplyClick}
    />
  );
}
