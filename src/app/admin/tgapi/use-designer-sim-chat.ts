"use client";

import { useCallback, useRef, useState } from "react";
import type { RefObject } from "react";
import type { TgSimulatorHandle } from "@/components/admin/tg-simulator";
import {
  isValidTgApiPlatformValue,
  renderMenuTemplate,
  TGAPI_PLATFORM_LABELS,
  type MenuButton,
} from "@/services/menu-config";
import { TGAPI_TEXTS_EN, TGAPI_TEXTS_ZH, type TgApiBotConfig } from "@/services/tgapi-config";

/**
 * 设计器弹窗仿真屏状态机（v2.3 重构抽取：与真实端 handlers/tgapi.ts 状态一一对应）。
 *
 * 数据驱动模型：仿真屏容器固定（右侧 TgSimulator），本 Hook 只维护「会话状态」
 * （视图 / 加群阶段 / 对话流程）；「配置状态」（菜单 / 键盘 / 文案）由弹窗持有并
 * 作为 props 传入 TgSimulator —— 配置改动即时呈现，即双向数据绑定：
 *   配置（弹窗 state） ──props──▶ 仿真屏渲染
 *   仿真屏交互（加群/按钮/输码）──▶ 本 Hook 会话状态推进
 *
 * 宿主：
 * - TGAPI「菜单和键盘」弹窗：使用全部能力（TGAPI 对话流程 / 语言切换 / 输码推进）；
 * - 机器人管理「功能配置」弹窗：仅使用视图与加群流（会话流由配置驱动，不假造 TGAPI 语义）。
 */

/** 仿真对话状态机（弹窗内仿真流程推进，与真实端 handlers/tgapi.ts 状态一一对应） */
interface SimFlowState {
  /** idle=未开始 / unlock=等待解锁验证码 / phone=手机号 / code=登录码 / prefTitle|prefDesc=设置Title|设置Description 偏好收集 */
  stage: "idle" | "unlock" | "phone" | "code" | "prefTitle" | "prefDesc";
  unlocked: boolean;
  /** 仿真中已记住的平台（设置平台按钮 tgapi_value 绑定；创建时优先使用） */
  platform?: string;
  phone?: string;
  /** 仿真中已创建的 API（我的API/已创建检测的数据源；demo 值明确标注仿真） */
  created: { phone: string; apiId: string; apiHash: string } | null;
  /** 当前按钮配置的结果消息模板（创建流程结束时渲染 success/fail 槽位） */
  pendingSuccess?: { zh: string; en: string };
  pendingFail?: { zh: string; en: string };
}

const SIM_DEMO_API = { apiId: "2049583", apiHash: "b6f1d4e2a9c8372f5d0e1a4b8c7d6e5f" };

export function useDesignerSimChat({
  simRef,
  cfg,
}: {
  simRef: RefObject<TgSimulatorHandle | null>;
  cfg: TgApiBotConfig;
}) {
  const [simLang, setSimLang] = useState<"zh" | "en">("zh");
  const [simView, setSimView] = useState<"group" | "private">("group");
  const [joinPhase, setJoinPhase] = useState<"idle" | "awaiting_code" | "joined">("idle");
  const [resetKey, setResetKey] = useState(0);
  const simFlow = useRef<SimFlowState>({ stage: "idle", unlocked: false, created: null });

  /** 双语槽位文案取值（优先当前语言，为空回落另一语言） */
  const slotText = useCallback(
    (template: { zh: string; en: string } | undefined): string => {
      if (!template) return "";
      return (
        (simLang === "zh" ? template.zh : template.en).trim() ||
        (simLang === "zh" ? template.en : template.zh).trim()
      );
    },
    [simLang],
  );

  /** 开始创建流程（已解锁，v2.2.2 精简）：直接手机号（APP 参数用预配置或默认值，不再收集） */
  const startSimCreate = useCallback((): void => {
    const texts = simLang === "zh" ? TGAPI_TEXTS_ZH : TGAPI_TEXTS_EN;
    simFlow.current.stage = "phone";
    simRef.current?.appendMessage("dm", { from: "bot", text: texts.askPhone });
  }, [simLang, simRef]);

  /** 「申请加群」按钮：仿真屏恢复申请加群初始状态 */
  const resetSimChat = useCallback((): void => {
    setResetKey((prev) => prev + 1);
    setSimView("group");
    setJoinPhase("idle");
    setSimLang("zh");
    simFlow.current = { stage: "idle", unlocked: false, created: null };
    simRef.current?.clearStream("group");
    simRef.current?.clearStream("dm");
  }, [simRef]);

  /** 点击「申请加入群组」：申请 → 自动通过（真实端 chat_join_request 自动 approve）→ 跳转私聊 */
  const requestJoin = useCallback(async (): Promise<{ ok: boolean; message: string }> => {
    simRef.current?.appendMessage("group", {
      from: "system",
      text: "📩 加入群组申请已发送（chat_join_request）",
    });
    window.setTimeout(() => {
      simRef.current?.appendMessage("group", {
        from: "system",
        text: "✅ 管理员（机器人）已自动通过你的申请",
      });
    }, 700);
    window.setTimeout(() => {
      setJoinPhase("joined");
      setSimView("private");
      simFlow.current.stage = "idle";
      window.setTimeout(() => {
        simRef.current?.appendMessage("dm", {
          from: "bot",
          text: "🤖 机器人已发送初始消息与按钮（见上方，随左侧配置实时同步）",
        });
      }, 350);
    }, 1400);
    return { ok: true, message: "" };
  }, [simRef]);

  /** TGAPI 功能按钮点击（创建API/我的API/启动机器人）——真实端执行流程仿真 */
  const onTgApiFunc = useCallback(
    (button: MenuButton): void => {
      const action = button.action;
      if (action.type !== "tgapi_func") return;
      const func = action.tgapi_func ?? "start";
      const flow = simFlow.current;
      const response = slotText(action.tgapi_response);
      if (response) {
        simRef.current?.appendMessage("dm", {
          from: "bot",
          text: renderMenuTemplate(response, {
            user_id: "777000",
            username: "preview_user",
            first_name: "预览",
            chat_id: "-1001998877661",
          }),
        });
      }
      if (func === "start") {
        // 重发新初始消息+内嵌按钮，旧消息和按钮过时失效（真实端：旧键盘移除 + 台账拦截）
        simRef.current?.clearStream("dm");
        simRef.current?.appendMessage("dm", {
          from: "system",
          text: "🔄 已重新发送初始消息：之前的消息与内嵌按钮已过时失效",
        });
        flow.stage = "idle";
        return;
      }
      if (func === "create") {
        // 1. 已创建检测（解锁门禁前）
        if (flow.created) {
          simRef.current?.appendMessage("dm", {
            from: "bot",
            text: "✅ 你的 api_id 和 api_hash 已创建，点击「🗂 我的 API」按钮查看。",
          });
          return;
        }
        // 2. 解锁门禁（每按钮可选；任意按钮通过后所有按钮不再需要验证）—— 唯一门禁提示
        if (action.tgapi_unlock === true && !flow.unlocked) {
          const texts = simLang === "zh" ? TGAPI_TEXTS_ZH : TGAPI_TEXTS_EN;
          flow.stage = "unlock";
          flow.pendingSuccess = action.tgapi_success;
          flow.pendingFail = action.tgapi_fail;
          simRef.current?.appendMessage("dm", { from: "bot", text: texts.unlockPrompt });
          return;
        }
        // 3. 已解锁/未开启门禁 → 创建流程
        flow.pendingSuccess = action.tgapi_success;
        flow.pendingFail = action.tgapi_fail;
        startSimCreate();
        return;
      }
      if (func === "my") {
        if (!flow.created) {
          const failText =
            slotText(action.tgapi_fail) ||
            (simLang === "zh"
              ? "💎 你还没有创建 API。\n\n点击 🗝 创建API 开始申请。"
              : "💎 You haven't created an API yet.\n\nTap 🗝 Create API to start.");
          simRef.current?.appendMessage("dm", { from: "bot", text: failText });
          return;
        }
        const vars = {
          phone: flow.created.phone,
          api_id: flow.created.apiId,
          api_hash: flow.created.apiHash,
        };
        const successText =
          slotText(action.tgapi_success) ||
          (simLang === "zh"
            ? `📱 号码：${vars.phone}\n🆔 api_id：${vars.api_id}\n🔑 api_hash：${vars.api_hash}`
            : `📱 Number: ${vars.phone}\n🆔 api_id: ${vars.api_id}\n🔑 api_hash: ${vars.api_hash}`);
        simRef.current?.appendMessage("dm", { from: "bot", text: renderMenuTemplate(successText, vars) });
        return;
      }
      // v2.2.0 固定指令全量仿真（设置平台/帮助/客服支持/设置Title/设置Description）
      if (func === "platform") {
        if (action.tgapi_value && isValidTgApiPlatformValue(action.tgapi_value)) {
          simFlow.current.platform = action.tgapi_value;
          const label = TGAPI_PLATFORM_LABELS[action.tgapi_value] ?? action.tgapi_value;
          simRef.current?.appendMessage("dm", {
            from: "bot",
            text: renderMenuTemplate(
              slotText(action.tgapi_success) ||
                (simLang === "zh"
                  ? `✅ APP 平台已设置为 ${label}，创建 API 时将优先使用。`
                  : `✅ App platform set to ${label}; it will be used when creating your API.`),
              { platform: label },
            ),
          });
          return;
        }
        simRef.current?.appendMessage("dm", {
          from: "bot",
          text:
            simLang === "zh"
              ? "📱 请在子菜单中选择平台（每行 2 个共 8 个平台按钮）；选中平台用于创建 APP 时提交。"
              : "📱 Please pick a platform in the submenu (8 options, 2 per row).",
        });
        return;
      }
      if (func === "help") {
        simRef.current?.appendMessage("dm", {
          from: "bot",
          text:
            renderMenuTemplate(response, {
              user_id: "777000",
              username: "preview_user",
              first_name: "预览",
            }) ||
            (simLang === "zh"
              ? "🆘 使用帮助：\n\n🗝 创建 API — 自动生成 api_id 和 api_hash\n🗂 我的 API — 查看已创建的 api_id 与 api_hash\n📱 设置平台 — 选择创建 APP 时的平台\n✅ 语言 — 中文/English 切换\n✏️ 设置Title / 📝 设置Description — 自定义 APP 名称与描述\n🎫 客服支持 — 联系管理员获取人工支持"
              : "🆘 How to use:\n\n🗝 Create API — generate api_id and api_hash\n🗂 My API — view your api_id and api_hash\n📱 Set Platform — choose the APP platform\n✅ Language — 中文/English\n✏️ Set Title / 📝 Set Description\n🎫 Support — contact the admin"),
        });
        return;
      }
      if (func === "support") {
        simRef.current?.appendMessage("dm", {
          from: "bot",
          text:
            renderMenuTemplate(response, {
              user_id: "777000",
              username: "preview_user",
              first_name: "预览",
            }) ||
            (simLang === "zh"
              ? "🎫 如需人工支持，请联系管理员。"
              : "🎫 For human support, please contact the admin."),
        });
        return;
      }
      if (func === "settitle" || func === "setdescription") {
        flow.stage = func === "settitle" ? "prefTitle" : "prefDesc";
        simRef.current?.appendMessage("dm", {
          from: "bot",
          text:
            func === "settitle"
              ? TGAPI_TEXTS_ZH.askAppTitle.replaceAll("{default}", cfg.appTitle)
              : TGAPI_TEXTS_ZH.askAppDescription.replaceAll("{default}", cfg.appDescription),
        });
      }
    },
    [cfg, simLang, simRef, slotText, startSimCreate],
  );

  /** 语言切换按钮：仿真屏实时切换双语文案 */
  const onLanguageToggle = useCallback((): boolean => {
    const next = simLang === "zh" ? "en" : "zh";
    setSimLang(next);
    simRef.current?.appendMessage("dm", {
      from: "bot",
      text: `✅ 语言已切换 / Language switched：${next === "zh" ? "中文" : "English"}`,
    });
    return true;
  }, [simLang, simRef]);

  /** 私聊输入（解锁验证码 / APP 名称 / 描述 / 手机号 / 登录码）——仿真状态机推进 */
  const onUserSend = useCallback(
    async (text: string): Promise<{ ok: boolean; text: string; joined?: boolean }> => {
      const flow = simFlow.current;
      const texts = simLang === "zh" ? TGAPI_TEXTS_ZH : TGAPI_TEXTS_EN;
      const input = text.trim();
      // 设置Title/设置Description 偏好收集仿真（只记录，不进入创建流程）
      if (flow.stage === "prefTitle") {
        if (!input || input.length > 32) {
          return { ok: false, text: "APP 名称不合法：请输入 1-32 个字符。" };
        }
        flow.stage = "idle";
        return { ok: true, text: `✅ APP 名称已设置为：${input}` };
      }
      if (flow.stage === "prefDesc") {
        if (!input || input.length > 200) {
          return { ok: false, text: "APP 描述不合法：请输入 1-200 个字符。" };
        }
        flow.stage = "idle";
        return { ok: true, text: `✅ APP 描述已设置为：${input}` };
      }
      if (flow.stage === "unlock") {
        // 仿真：任意非空验证码通过（真实端走外部 API 核验）；解锁一次永久有效
        if (!input) return { ok: false, text: "请输入解锁验证码" };
        flow.unlocked = true;
        flow.stage = "idle";
        window.setTimeout(() => startSimCreate(), 300);
        return { ok: true, text: "🔐 验证通过（仿真：任意验证码即可通过，真实端走外部 API 核验）" };
      }
      if (flow.stage === "phone") {
        const phone = input.replace(/[^\d+]/g, "");
        if (!/^\+\d{7,15}$/.test(phone)) {
          return { ok: false, text: texts.invalidPhone };
        }
        flow.phone = phone;
        flow.stage = "code";
        return { ok: true, text: texts.afterRecvdCode };
      }
      if (flow.stage === "code") {
        // 登录码 → 抓取/创建 APP → 结果（仿真演示值；真实端登录 my.telegram.org 真实抓取）
        flow.stage = "idle";
        window.setTimeout(() => {
          const created = { phone: flow.phone ?? "+8613800138000", ...SIM_DEMO_API };
          flow.created = created;
          simRef.current?.appendMessage("dm", {
            from: "bot",
            text:
              `Phone Number: ${created.phone}\n\n` +
              "App Configuration\n" +
              `APP ID: ${created.apiId}\n` +
              `API HASH: ${created.apiHash}\n\n` +
              "（仿真演示数据；真实端登录 my.telegram.org 抓取/创建后返回真实值）",
          });
          const successRaw = slotText(flow.pendingSuccess);
          if (successRaw) {
            simRef.current?.appendMessage("dm", {
              from: "bot",
              text: renderMenuTemplate(successRaw, {
                ...created,
                api_id: created.apiId,
                api_hash: created.apiHash,
              }),
            });
          }
        }, 1200);
        return { ok: true, text: texts.beforeSuccLogin };
      }
      return { ok: true, text: texts.start };
    },
    [simLang, simRef, slotText, startSimCreate],
  );

  return {
    simLang,
    simView,
    joinPhase,
    resetKey,
    resetSimChat,
    requestJoin,
    onTgApiFunc,
    onLanguageToggle,
    onUserSend,
  };
}
