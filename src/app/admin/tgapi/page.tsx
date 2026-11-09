import {
  listBots,
  listTgApiUnlocks,
  listVerificationMethods,
} from "@/database/operations";
import { formatBeijingDateTimeMinute } from "@/utils/datetime";
import { requirePermission } from "@/lib/auth";
import { probeBotDeployState } from "@/services/bot-deploy";
import { BotDeployBadge, briefDeployDetail } from "@/components/admin/bot-deploy-badge";
import { parseTgApiBotConfig, type TgApiBotConfig } from "@/services/tgapi-config";
import { TgApiApplyWizard } from "@/components/admin/tgapi-apply-wizard";
import { TgApiBotDesignerDialog } from "./bot-designer-dialog";
import {
  deleteTgApiBotAction,
  revokeTgApiUnlockAction,
  toggleTgApiBotAction,
} from "./actions";

export const dynamic = "force-dynamic";

const NOTICES: Record<string, string> = {
  "1": "TGAPI 申请机器人已保存（仅配置落库；上线/更新运行实例请到「仿真APP」页面点击「🚀 部署机器人」）",
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
};

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

/**
 * v2.1.10 整合：真实部署状态探测的唯一实现在 services/bot-deploy.ts
 *（probeBotDeployState），展示徽章在 components/admin/bot-deploy-badge.tsx ——
 * 机器人管理页列表与本页列表共用同一实现（本文件不再保留探测/徽章副本）。
 * v2.1.11：部署入口统一收敛到「仿真APP」页面（列表「🚀 部署」改为跳转链接），
 * 本页不再保留独立部署动作；部署状态徽章继续真实探测（部署后自动同步）。
 */

export default async function TgApiPage({
  searchParams,
}: {
  searchParams: Promise<{
    bot?: string;
    saved?: string;
    error?: string;
    deploy?: string;
    deploy_msg?: string;
    edit?: string;
  }>;
}) {
  await requirePermission("tgapi:view");
  const params = await searchParams;

  const [bots, methods] = await Promise.all([listBots(), listVerificationMethods()]);
  const tgapiBots = bots.filter((bot) => parseTgApiBotConfig(bot.config).enabled);
  const methodById = new Map(methods.map((method) => [String(method.id), method]));
  const methodOptions = methods.map((method) => ({
    id: Number(method.id),
    name: method.name,
    enabled: method.enabled,
    type: method.type,
  }));
  // 真实部署状态逐 bot 并行探测（webhook=Telegram 侧权威值；polling=本进程运行实例）
  const deployChecks = await Promise.all(tgapiBots.map((bot) => probeBotDeployState(bot)));

  const selectedBotId =
    params.bot && /^\d+$/.test(params.bot) ? params.bot : null;
  const selectedBot = selectedBotId
    ? tgapiBots.find((bot) => String(bot.id) === selectedBotId) ?? null
    : null;
  const unlocks = selectedBot ? await listTgApiUnlocks(selectedBot.id) : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold">TGAPI申请</h1>
          <p className="text-sm text-muted-foreground">
            用户私聊发送 APP 名称/描述 → 手机号 → Telegram 发送登录码 → 机器人登录
            my.telegram.org 抓取/自动创建 APP → 返回 API ID 与 API HASH。
            中英文双语（按用户语言自动识别，消息内嵌按钮「语言切换」可手动切换）。首次对话需要解锁（外部 API
            验证码或 Telegram 星星支付，可切换），解锁一次永久有效，重复申请无需再次解锁。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <TgApiApplyWizard />
          <TgApiBotDesignerDialog
            methods={methodOptions}
            trigger="+ 新增 TGAPI 申请机器人"
            triggerClassName="inline-flex h-10 shrink-0 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          />
        </div>
      </div>

      {params.saved && NOTICES[params.saved] ? (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          {NOTICES[params.saved]}
        </div>
      ) : null}
      {params.error && ERRORS[params.error] ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {ERRORS[params.error]}
        </div>
      ) : null}
      {params.deploy && params.deploy_msg ? (
        params.deploy === "ok" ? (
          <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
            🚀 {params.deploy_msg}
          </div>
        ) : params.deploy === "fail" ? (
          <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            ❌ {params.deploy_msg}
          </div>
        ) : params.deploy === "pending" ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
            ⏳ {params.deploy_msg}
          </div>
        ) : (
          <div className="rounded-md border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600">
            {params.deploy_msg}
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
                <th className="px-4 py-3 font-medium">解锁配置</th>
                <th className="px-4 py-3 font-medium">APP 参数</th>
                <th className="px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium">部署状态</th>
                <th className="px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {tgapiBots.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    还没有 TGAPI 申请机器人，点击右上角「新增 TGAPI 申请机器人」创建
                  </td>
                </tr>
              ) : (
                tgapiBots.map((bot, index) => {
                  const cfg = parseTgApiBotConfig(bot.config);
                  const methodName = cfg.verificationMethodId
                    ? methodById.get(String(cfg.verificationMethodId))?.name ?? `#${cfg.verificationMethodId}`
                    : null;
                  return (
                    <tr key={String(bot.id)} className="border-b last:border-0">
                      <td className="px-4 py-3 text-sm font-mono">{String(bot.id)}</td>
                      <td className="px-4 py-3 text-sm">{bot.name}</td>
                      <td className="px-4 py-3 font-mono text-sm">
                        {bot.username ? `@${bot.username}` : "-"}
                      </td>
                      <td className="px-4 py-3">
                        <UnlockModeBadge mode={cfg.unlockMode} />
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
                          <BotDeployBadge check={deployChecks[index] ?? { key: "unknown", detail: "探测结果缺失" }} />
                          {"detail" in (deployChecks[index] ?? {}) &&
                          (deployChecks[index] as { detail?: string }).detail ? (
                            <p className="text-xs leading-snug text-muted-foreground">
                              {briefDeployDetail((deployChecks[index] as { detail: string }).detail)}
                            </p>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <a
                            href={`/admin/bots/testing?bot=${String(bot.id)}`}
                            title="统一部署入口：跳转到「仿真APP」页面，选中本机器人后点击「🚀 部署机器人」上线/更新"
                            className="inline-flex h-8 items-center rounded-md border border-emerald-200 bg-emerald-50 px-3 text-sm font-medium text-emerald-700 hover:bg-emerald-100"
                          >
                            🚀 部署
                          </a>
                          <TgApiBotDesignerDialog
                            bot={{
                              id: String(bot.id),
                              name: bot.name,
                              username: bot.username,
                              enabled: bot.enabled,
                              config: bot.config,
                              menuConfig: bot.menuConfig,
                            }}
                            methods={methodOptions}
                            defaultOpen={params.edit === "1" && String(bot.id) === selectedBotId}
                            trigger="编辑"
                            triggerClassName="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-accent"
                          />
                          <a
                            href={`/admin/tgapi?bot=${String(bot.id)}&edit=1`}
                            title="在 TGAPI 设计器弹窗中配置初始消息与内嵌按钮"
                            className="inline-flex h-8 items-center rounded-md border border-primary/50 px-3 text-sm font-medium text-primary hover:bg-primary/10"
                          >
                            ⚙️ 消息与按钮
                          </a>
                          <a
                            href={`/admin/tgapi?bot=${String(bot.id)}`}
                            className="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-accent"
                          >
                            解锁用户
                          </a>
                          <form action={toggleTgApiBotAction}>
                            <input type="hidden" name="id" value={String(bot.id)} />
                            <input type="hidden" name="enable" value={bot.enabled ? "0" : "1"} />
                            <button
                              type="submit"
                              className="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-accent"
                            >
                              {bot.enabled ? "停用" : "启用"}
                            </button>
                          </form>
                          <form action={deleteTgApiBotAction}>
                            <input type="hidden" name="id" value={String(bot.id)} />
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

      {selectedBot ? (
        <div className="rounded-xl border bg-card">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div className="text-sm font-semibold">
              解锁用户 · {selectedBot.name}（{unlocks.length} 人）
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
                {unlocks.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">
                      暂无解锁用户
                    </td>
                  </tr>
                ) : (
                  unlocks.map((unlock) => (
                    <tr key={String(unlock.id)} className="border-b last:border-0">
                      <td className="px-4 py-3 text-sm font-mono">{String(unlock.id)}</td>
                      <td className="px-4 py-3 font-mono text-sm">{String(unlock.userId)}</td>
                      <td className="px-4 py-3 text-sm">
                        {unlock.username ? `@${unlock.username}` : "-"}
                      </td>
                      <td className="px-4 py-3">
                        <UnlockModeBadge mode={unlock.mode} />
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {formatBeijingDateTimeMinute(unlock.updatedTime)}
                      </td>
                      <td className="px-4 py-3">
                        <form action={revokeTgApiUnlockAction}>
                          <input type="hidden" name="id" value={String(unlock.id)} />
                          <input type="hidden" name="bot_id" value={String(selectedBot.id)} />
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
