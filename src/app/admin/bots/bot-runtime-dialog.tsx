"use client";

import { useState } from "react";
import { FormDialog } from "@/components/admin/form-dialog";
import { SelfContainedTabs } from "@/components/admin/self-contained-tabs";
import { saveBotRuntimeAction } from "./actions";

/**
 * 机器人「运行配置」弹窗（单项配置）：
 * - Tab 运行模式：跟随全局 / 长轮询 / Webhook（跟随全局时默认 Webhook；Node 未配置回调地址时回退轮询）
 * - Tab 隐私模式：跟随全局 / 开启 / 关闭（Telegram 侧需在 BotFather /setprivacy 同步）
 * 保存后服务端立即热应用（轮询↔Webhook 自动切换，含 setWebhook/deleteWebhook）。
 */

export interface BotRuntimeDialogProps {
  bot: {
    id: string;
    name: string;
    transportMode: "inherit" | "polling" | "webhook";
    privacySetting: "inherit" | "on" | "off";
  };
  global: {
    mode: "auto" | "polling" | "webhook";
    webhookBaseUrl: string;
    privacyEnabled: boolean;
  };
  resolved: { mode: "polling" | "webhook"; privacy: boolean; isEdge: boolean };
  trigger: string;
  triggerClassName?: string;
}

const optionCardClass = (active: boolean): string =>
  `w-full rounded-lg border p-3 text-left transition-colors ${
    active
      ? "border-primary bg-primary/5 ring-1 ring-primary"
      : "border-input hover:border-primary/50 hover:bg-muted/40"
  }`;

export function BotRuntimeDialog({
  bot,
  global,
  resolved,
  trigger,
  triggerClassName = "inline-flex h-8 items-center rounded-md border border-primary/50 px-3 text-sm text-primary hover:bg-primary/10",
}: BotRuntimeDialogProps) {
  const [transport, setTransport] = useState(bot.transportMode);
  const [privacy, setPrivacy] = useState(bot.privacySetting);

  const globalModeLabel =
    global.mode === "auto"
      ? `自动（默认 Webhook${resolved.isEdge ? "" : "；未配置回调地址时回退轮询"}）`
      : global.mode === "polling"
        ? "长轮询"
        : "Webhook";

  const effectiveTransportLabel =
    transport === "inherit"
      ? `跟随全局 → ${resolved.mode === "webhook" ? "Webhook" : "长轮询"}`
      : transport === "polling"
        ? "长轮询"
        : "Webhook";
  const effectivePrivacyLabel =
    privacy === "inherit"
      ? `跟随全局 → ${resolved.privacy ? "开启" : "关闭"}`
      : privacy === "on"
        ? "开启"
        : "关闭";

  return (
    <FormDialog
      trigger={trigger}
      triggerClassName={triggerClassName}
      title={`运行配置 · ${bot.name}`}
      description="传输模式与隐私模式支持全局统一默认 + 每机器人单项覆盖；保存后立即热应用。"
      action={saveBotRuntimeAction}
      submitLabel="保存并热应用"
    >
      <input type="hidden" name="id" value={bot.id} />
      <input type="hidden" name="transportMode" value={transport} />
      <input type="hidden" name="privacySetting" value={privacy} />

      <SelfContainedTabs
        ariaLabel="机器人运行配置"
        items={[
          {
            key: "transport",
            label: "🚚 运行模式",
            content: (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  全局当前：<b>{globalModeLabel}</b>
                  {global.mode === "webhook" || resolved.mode === "webhook" ? (
                    <>
                      {" "}· Webhook 地址前缀：<code className="font-mono">{global.webhookBaseUrl || "（未配置，保存时自动取站点地址）"}</code>
                    </>
                  ) : null}
                </p>
                <div className="grid grid-cols-1 gap-2">
                  <button type="button" className={optionCardClass(transport === "inherit")} onClick={() => setTransport("inherit")}>
                    <div className="text-sm font-medium">跟随全局</div>
                    <div className="text-xs text-muted-foreground">
                      使用系统设置中的全局默认（当前 → {resolved.mode === "webhook" ? "Webhook" : "长轮询"}）
                    </div>
                  </button>
                  <button type="button" className={optionCardClass(transport === "polling")} onClick={() => setTransport("polling")}>
                    <div className="text-sm font-medium">长轮询（getUpdates）</div>
                    <div className="text-xs text-muted-foreground">
                      本进程主动经全局代理调用 getUpdates 拉取更新（入站更新由代理链路拉回）；
                      适合本地开发 / 内网 / VPS 等无法被 Telegram 回调的环境，无需公网 URL
                    </div>
                  </button>
                  <button type="button" className={optionCardClass(transport === "webhook")} onClick={() => setTransport("webhook")}>
                    <div className="text-sm font-medium">Webhook（setWebhook）</div>
                    <div className="text-xs text-muted-foreground">
                      Telegram 主动推送到公网 HTTPS 回调地址（经网关/公网暴露）；
                      serverless / Cloudflare Pages 唯一可用方式，Node 环境出站调用自动走全局代理
                    </div>
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">
                  保存后生效：<b>{effectiveTransportLabel}</b>
                  {resolved.isEdge ? "（Edge 环境强制 Webhook —— serverless 无法长轮询）" : ""}
                </p>
              </div>
            ),
          },
          {
            key: "privacy",
            label: "🙈 隐私模式",
            content: (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  全局当前：<b>{global.privacyEnabled ? "开启" : "关闭"}</b>
                </p>
                <div className="grid grid-cols-1 gap-2">
                  <button type="button" className={optionCardClass(privacy === "inherit")} onClick={() => setPrivacy("inherit")}>
                    <div className="text-sm font-medium">跟随全局</div>
                    <div className="text-xs text-muted-foreground">使用系统设置中的全局默认（当前 → {resolved.privacy ? "开启" : "关闭"}）</div>
                  </button>
                  <button type="button" className={optionCardClass(privacy === "on")} onClick={() => setPrivacy("on")}>
                    <div className="text-sm font-medium">开启（推荐验证类机器人）</div>
                    <div className="text-xs text-muted-foreground">
                      bot 收不到群内普通消息，仅 /命令、回复、@bot；验证码等敏感交互走私聊，群里其他人看不到
                    </div>
                  </button>
                  <button type="button" className={optionCardClass(privacy === "off")} onClick={() => setPrivacy("off")}>
                    <div className="text-sm font-medium">关闭</div>
                    <div className="text-xs text-muted-foreground">
                      bot 接收群内全部消息（关键词监听/统计场景）；验证场景不建议
                    </div>
                  </button>
                </div>
                <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                  重要：本配置控制本系统的指令匹配行为；Telegram 侧隐私模式需在 BotFather → /setprivacy
                  同步设置（API 无修改入口）。方向是「bot 看不到用户」；用户与 bot 的对话要对群里
                  其他人不可见，必须走 bot 私聊（验证链接已内置）。
                </p>
                <p className="text-xs text-muted-foreground">
                  保存后生效：<b>{effectivePrivacyLabel}</b>
                </p>
              </div>
            ),
          },
        ]}
      />
    </FormDialog>
  );
}
