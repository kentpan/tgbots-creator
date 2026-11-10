"use client";

import { useEffect, useState } from "react";
import { BotDeployBadge, briefDeployDetail } from "@/components/admin/bot-deploy-badge";
import { TgApiApplyWizard } from "@/components/admin/tgapi-apply-wizard";
import { parseTgApiBotConfig } from "@/services/tgapi-config";
import type { BotDeployCheck } from "@/services/bot-deploy";
import { TgApiMenuKeyboardDialog } from "./bot-designer-dialog";
import {
  deleteTgApiBotAction,
  revokeTgApiUnlockAction,
  toggleTgApiBotAction,
} from "./actions";

/**
 * TGAPI申请 页面 · 视觉层（v2.2.1 CSR）：
 *
 * SSR（page.tsx）只做数据层与鉴权（requirePermission + DB 读取），本组件负责
 * 全部视觉渲染；部署状态探测（逐 bot 调 Telegram getWebhookInfo 的跨网络往返）
 * 挂载后经 /api/admin/bot-deploy-status 异步拉取 —— 页面首屏不再被网络探测阻塞。
 */

const NOTICES: Record<string, string> = {
  "1": "TGAPI 申请机器人已保存（仅配置落库；上线/更新运行实例请到「仿真APP」页面点击「🚀 部署机器人」）",
  keyboard: "自定义键盘已保存（对话流程即时生效；保存空键盘回到消息内嵌按钮模式）",
  deleted: "机器人已删除",
  enabled: "机器人已启用",
  disabled: "机器人已停用",
  revoked: "已撤销该用户的解锁状态",
};

const ERRORS: Record<string, string> = {
  "name-required": "请填写机器人名称",
  "invalid-token": "Token 格式不合法（新建时必填，编辑时留空保留原 Token）",
  "invalid-id": "记录不存在",
  "method-required": "验证码解锁模式必须绑定一个外部 API 验证方式",
  "invalid-stars": "星星解锁金额必须是大于等于 1 的整数",
  "invalid-menu": "内嵌按钮配置不合法（请重新打开弹窗后保存）",
  "invalid-keyboard": "自定义键盘配置不合法（请重新打开弹窗后保存）",
};

function KeyboardModeBadge({ custom }: { custom: boolean }) {
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-sm ${
        custom
          ? "border-sky-200 bg-sky-50 text-sky-700"
          : "border-gray-200 bg-gray-50 text-gray-600"
      }`}
      title={
        custom
          ? "自定义键盘对话流程生效（互斥：消息内嵌按钮不再渲染）"
          : "消息内嵌按钮模式（配置自定义键盘后自动切换到对话流程）"
      }
    >
      {custom ? "⌨️ 自定义键盘流程" : "🔘 消息内嵌按钮"}
    </span>
  );
}

function UnlockModeBadge({ mode }: { mode: string }) {
  const isStars = mode === "stars";
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-sm ${
        isStars
          ? "border-amber-200 bg-amber-50 text-amber-700"
          : "border-emerald-200 bg-emerald-50 text-emerald-700"
      }`}
    >
      {isStars ? "⭐ 星星解锁" : "🔐 验证码解锁"}
    </span>
  );
}

export interface TgApiBotListItem {
  id: string;
  name: string;
  username: string | null;
  enabled: boolean;
  config: string;
  menuConfig: string;
}

export interface TgApiUnlockItem {
  id: string;
  userId: string;
  username: string | null;
  mode: string;
  /** 服务端预格式化的北京时间（数据层产出，视觉层直接展示） */
  time: string;
}

export function TgApiPageClient({
  bots,
  methods,
  notices,
  editBotId,
  unlockPanel,
}: {
  bots: TgApiBotListItem[];
  methods: { id: number; name: string; enabled: boolean; type: string }[];
  notices: { saved?: string; error?: string; deploy?: string; deployMsg?: string };
  /** ?edit=1 时自动打开该机器人的「菜单和键盘」弹窗 */
  editBotId: string | null;
  /** ?bot=<id>（无 edit=1）：解锁用户面板 */
  unlockPanel: { botId: string; botName: string; unlocks: TgApiUnlockItem[] } | null;
}) {
  // 部署状态：客户端挂载后异步探测（SSR 不做网络探测）
  const [deployChecks, setDeployChecks] = useState<Record<string, BotDeployCheck>>({});
  const [deployError, setDeployError] = useState<string | null>(null);

  useEffect(() => {
    if (bots.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(
          `/api/admin/bot-deploy-status?ids=${bots.map((bot) => bot.id).join(",")}`,
        );
        const payload = (await response.json()) as {
          ok: boolean;
          checks?: Record<string, BotDeployCheck>;
          error?: string;
        };
        if (cancelled) return;
        if (!payload.ok || !payload.checks) {
          setDeployError(payload.error ?? `探测接口异常（HTTP ${response.status}）`);
          return;
        }
        setDeployChecks(payload.checks);
      } catch (error) {
        if (!cancelled) {
          setDeployError(error instanceof Error ? error.message : String(error));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bots]);

  const methodById = new Map(methods.map((method) => [String(method.id), method]));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold">TGAPI申请</h1>
          <p className="text-sm text-muted-foreground">
            用户私聊发送 APP 名称/描述 → 手机号 → Telegram 发送登录码 → 机器人登录
            my.telegram.org 抓取/自动创建 APP → 返回 API ID 与 API HASH。
            中英文双语（按用户语言自动识别，语言按钮可手动切换）。首次对话需要解锁（外部 API
            验证码或 Telegram 星星支付，可切换），解锁一次永久有效，重复申请无需再次解锁。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <TgApiApplyWizard />
          <TgApiMenuKeyboardDialog
            methods={methods}
            trigger="+ 新增 TGAPI 申请机器人"
            triggerClassName="inline-flex h-10 shrink-0 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          />
        </div>
      </div>

      {notices.saved && NOTICES[notices.saved] ? (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          {NOTICES[notices.saved]}
        </div>
      ) : null}
      {notices.error && ERRORS[notices.error] ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {ERRORS[notices.error]}
        </div>
      ) : null}
      {notices.deploy && notices.deployMsg ? (
        notices.deploy === "ok" ? (
          <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
            🚀 {notices.deployMsg}
          </div>
        ) : notices.deploy === "fail" ? (
          <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            ❌ {notices.deployMsg}
          </div>
        ) : notices.deploy === "pending" ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
            ⏳ {notices.deployMsg}
          </div>
        ) : (
          <div className="rounded-md border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600">
            {notices.deployMsg}
          </div>
        )
      ) : null}

      <div className="rounded-xl border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-sm text-muted-foreground">
                <th className="px-4 py-3 font-medium">ID</th>
                <th className="px-4 py-3 font-medium">名称</th>
                <th className="px-4 py-3 font-medium">用户名</th>
                <th className="px-4 py-3 font-medium">解锁方式</th>
                <th className="px-4 py-3 font-medium">键盘模式</th>
                <th className="px-4 py-3 font-medium">解锁配置</th>
                <th className="px-4 py-3 font-medium">APP 参数</th>
                <th className="px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium">部署状态</th>
                <th className="px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {bots.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    还没有 TGAPI 申请机器人，点击右上角「新增 TGAPI 申请机器人」创建
                  </td>
                </tr>
              ) : (
                bots.map((bot) => {
                  const cfg = parseTgApiBotConfig(bot.config);
                  const methodName = cfg.verificationMethodId
                    ? methodById.get(String(cfg.verificationMethodId))?.name ?? `#${cfg.verificationMethodId}`
                    : null;
                  const check = deployChecks[bot.id];
                  return (
                    <tr key={bot.id} className="border-b last:border-0">
                      <td className="px-4 py-3 text-sm font-mono">{bot.id}</td>
                      <td className="px-4 py-3 text-sm">{bot.name}</td>
                      <td className="px-4 py-3 font-mono text-sm">
                        {bot.username ? `@${bot.username}` : "-"}
                      </td>
                      <td className="px-4 py-3">
                        <UnlockModeBadge mode={cfg.unlockMode} />
                      </td>
                      <td className="px-4 py-3">
                        <KeyboardModeBadge custom={Boolean(cfg.customKeyboard)} />
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {cfg.unlockMode === "captcha"
                          ? `验证方式：${methodName ?? "未配置"}`
                          : `${cfg.starsAmount ?? "-"} ⭐${cfg.starsTitle ? `（${cfg.starsTitle}）` : ""}`}
                      </td>
                      <td className="max-w-52 truncate px-4 py-3 text-sm text-muted-foreground" title={`${cfg.appTitle} / ${cfg.appShortName}`}>
                        {cfg.appTitle} / {cfg.appShortName}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full border px-2 py-0.5 text-sm ${
                            bot.enabled
                              ? "border-green-200 bg-green-50 text-green-700"
                              : "border-gray-200 bg-gray-50 text-gray-500"
                          }`}
                        >
                          {bot.enabled ? "启用" : "停用"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="max-w-56 space-y-1">
                          {check ? (
                            <BotDeployBadge check={check} />
                          ) : (
                            <span
                              className="inline-flex animate-pulse rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-sm text-gray-500"
                              title={deployError ?? "正在探测真实部署状态（Telegram getWebhookInfo）"}
                            >
                              {deployError ? "状态未知" : "探测中…"}
                            </span>
                          )}
                          {check && "detail" in check && check.detail ? (
                            <p className="text-xs leading-snug text-muted-foreground">
                              {briefDeployDetail(check.detail)}
                            </p>
                          ) : null}
                          {deployError && !check ? (
                            <p className="text-xs leading-snug text-red-600">{deployError}</p>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <a
                            href={`/admin/bots/testing?bot=${bot.id}`}
                            title="统一部署入口：跳转到「仿真APP」页面，选中本机器人后点击「🚀 部署机器人」上线/更新"
                            className="inline-flex h-8 items-center rounded-md border border-emerald-200 bg-emerald-50 px-3 text-sm font-medium text-emerald-700 hover:bg-emerald-100"
                          >
                            🚀 部署
                          </a>
                          <TgApiMenuKeyboardDialog
                            bot={bot}
                            methods={methods}
                            defaultOpen={editBotId === bot.id}
                            defaultTab={cfg.customKeyboard ? "keyboard" : "inline"}
                            trigger="⚙️ 菜单和键盘"
                            triggerClassName="inline-flex h-8 items-center rounded-md border border-primary/50 px-3 text-sm font-medium text-primary hover:bg-primary/10"
                          />
                          <a
                            href={`/admin/tgapi?bot=${bot.id}`}
                            className="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-accent"
                          >
                            解锁用户
                          </a>
                          <form action={toggleTgApiBotAction}>
                            <input type="hidden" name="id" value={bot.id} />
                            <input type="hidden" name="enable" value={bot.enabled ? "0" : "1"} />
                            <button
                              type="submit"
                              className="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-accent"
                            >
                              {bot.enabled ? "停用" : "启用"}
                            </button>
                          </form>
                          <form action={deleteTgApiBotAction}>
                            <input type="hidden" name="id" value={bot.id} />
                            <button
                              type="submit"
                              className="inline-flex h-8 items-center rounded-md border border-red-200 px-3 text-sm font-medium text-red-600 hover:bg-red-50"
                            >
                              删除
                            </button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {unlockPanel ? (
        <div className="rounded-xl border bg-card">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div className="text-sm font-semibold">
              解锁用户 · {unlockPanel.botName}（{unlockPanel.unlocks.length} 人）
            </div>
            <a href="/admin/tgapi" className="text-sm text-muted-foreground hover:underline">
              返回机器人列表
            </a>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b text-left text-sm text-muted-foreground">
                  <th className="px-4 py-3 font-medium">ID</th>
                  <th className="px-4 py-3 font-medium">用户 ID</th>
                  <th className="px-4 py-3 font-medium">用户名</th>
                  <th className="px-4 py-3 font-medium">解锁方式</th>
                  <th className="px-4 py-3 font-medium">解锁时间</th>
                  <th className="px-4 py-3 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {unlockPanel.unlocks.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">
                      暂无解锁用户
                    </td>
                  </tr>
                ) : (
                  unlockPanel.unlocks.map((unlock) => (
                    <tr key={unlock.id} className="border-b last:border-0">
                      <td className="px-4 py-3 text-sm font-mono">{unlock.id}</td>
                      <td className="px-4 py-3 font-mono text-sm">{unlock.userId}</td>
                      <td className="px-4 py-3 text-sm">
                        {unlock.username ? `@${unlock.username}` : "-"}
                      </td>
                      <td className="px-4 py-3">
                        <UnlockModeBadge mode={unlock.mode} />
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">{unlock.time}</td>
                      <td className="px-4 py-3">
                        <form action={revokeTgApiUnlockAction}>
                          <input type="hidden" name="id" value={unlock.id} />
                          <input type="hidden" name="bot_id" value={unlockPanel.botId} />
                          <button
                            type="submit"
                            className="inline-flex h-8 items-center rounded-md border border-red-200 px-3 text-sm font-medium text-red-600 hover:bg-red-50"
                          >
                            撤销解锁
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
