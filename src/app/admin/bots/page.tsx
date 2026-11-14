import {
  listBots,
  listBotCommands,
  listGroupSettings,
  listVerificationMethods,
} from "@/database/operations";
import { formatBeijingDateTimeMinute } from "@/utils/datetime";
import { getStorage } from "@/database/bindings";
import { countMenuStats, parseBotMenuConfig } from "@/services/menu-config";
import { getTelegramRuntimeSettings, resolveBotRuntime } from "@/services/bot-transport";
import { DeployStatusCell } from "@/components/admin/deploy-status-cell";
import { isEdgeRuntime } from "@/lib/telegram/runtime-mode";
import { parseBotProfile, parseBotPrivacyMode } from "@/bot/multi-runtime";
import { parseTgApiBotConfig } from "@/services/tgapi-config";
import { parseCustomKeyboardConfig } from "@/services/custom-keyboard";
import { requirePermission } from "@/lib/auth";
import { deleteBotAction, deployBotAction } from "./actions";
import { SubmitButton } from "@/components/admin/submit-button";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { BotFormDialog } from "./bot-form-dialog";
import { FeatureConfigDialog } from "./feature-config-dialog";
import { BotRuntimeDialog } from "./bot-runtime-dialog";
import { BotCreateGuide } from "./bot-create-guide";

export const dynamic = "force-dynamic";

const NOTICES: Record<string, string> = {
  "1": "机器人已保存",
  menu: "消息内嵌按钮配置已保存，运行实例已热更新",
  sync: "消息内嵌按钮已真实同步到群组",
  keyboard: "自定义键盘已保存，运行实例已热更新",
  deleted: "机器人已删除",
  profile: "官方资料已应用到机器人",
  commands: "指令菜单已保存并同步到 Telegram",
};

const ERRORS: Record<string, string> = {
  "name-required": "请填写备注名称",
  "invalid-token": "Token 格式不合法（应为 123456789:AAxxxx 形式）",
  "duplicate-token": "该 Token 已存在",
  "invalid-id": "机器人不存在",
  "invalid-menu": "消息内嵌按钮配置不合法",
  "invalid-keyboard": "自定义键盘配置不合法，请重新打开弹窗后保存",
  "invalid-commands": "指令菜单数据不合法，请重试",
  "runtime": "机器人运行配置已保存并热应用",
};

// v2.0.13：时间展示统一北京时间（服务器/Edge 运行时时区为 UTC）
function formatDateTime(date: Date): string {
  return formatBeijingDateTimeMinute(date);
}

function maskToken(token: string): string {
  if (token.length <= 12) return token;
  return `${token.slice(0, 8)}••••${token.slice(-4)}`;
}

export default async function BotsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string; message?: string; deploy?: string; deploy_msg?: string }>;
}) {
  await requirePermission("bots:view");
  const params = await searchParams;
  const [allBots, groups, builtinCommands, customCommands, verificationMethods] = await Promise.all([
    listBots(),
    listGroupSettings(),
    listBotCommands({ type: "builtin", enabledOnly: true }),
    listBotCommands({ type: "custom", enabledOnly: true }),
    listVerificationMethods(),
  ]);
  // TGAPI申请机器人不在机器人管理列表重复显示（TGAPI机器人由 /admin/tgapi 页管理）
  const bots = allBots.filter((bot) => !parseTgApiBotConfig(bot.config).enabled);
  const commandLibrary = [...builtinCommands.rows, ...customCommands.rows].map((row) => ({
    id: String(row.id),
    name: row.name,
    description: row.description,
    intro: row.intro,
    type: row.type,
    // 指令归属（v2.1.13）：机器人私有 / 群组私有 / 全局，供各机器人按归属过滤与标注
    botId: row.botId === null ? null : String(row.botId),
    groupId: row.groupId === null ? null : String(row.groupId),
  }));
  const runtimeGlobal = await getTelegramRuntimeSettings();
  const isEdge = isEdgeRuntime();
  // v2.2.1 SSR/CSR 分层：部署状态探测（逐 bot 调 Telegram getWebhookInfo 的跨网络往返）
  // 不再阻塞首屏 —— 由 DeployStatusCell（客户端）挂载后经 /api/admin/bot-deploy-status 异步探测

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">机器人管理</h1>
          <p className="text-sm text-muted-foreground">
            维护多个机器人（Token 与官方 API 配置项），为每个机器人设计 grammY 消息内嵌按钮并真实同步到群组。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <BotCreateGuide />
          <BotFormDialog
            trigger="+ 新增机器人"
            triggerClassName="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          />
        </div>
      </div>

      {params.saved && NOTICES[params.saved] ? (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          {NOTICES[params.saved]}
          {params.saved === "sync" && params.message ? `（${params.message}）` : ""}
        </div>
      ) : null}
      {params.error && ERRORS[params.error] ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {ERRORS[params.error]}
          {params.error === "invalid-menu" && params.message ? `：${params.message}` : ""}
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
                <th className="px-4 py-3 font-medium">备注名称</th>
                <th className="px-4 py-3 font-medium">账号</th>
                <th className="px-4 py-3 font-medium">Token</th>
                <th className="px-4 py-3 font-medium">消息内嵌按钮</th>
                <th className="px-4 py-3 font-medium">运行 / 隐私</th>
                <th className="px-4 py-3 font-medium">部署状态</th>
                <th className="px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium">更新时间</th>
                <th className="px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {bots.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    还没有机器人，点击右上角「从零创建机器人」按引导创建，或「新增机器人」直接接入 Token
                  </td>
                </tr>
              ) : (
                bots.map((bot) => {
                  const stats = countMenuStats(parseBotMenuConfig(bot.menuConfig).root);
                  const profile = parseBotProfile(bot.config);
                  // v2.3 指令归属过滤：本机器人可见的自定义指令 = 全局 + 群组私有 + 本机器人私有
                  const visibleCommands = commandLibrary.filter(
                    (item) =>
                      item.type === "builtin" || item.botId === null || item.botId === String(bot.id),
                  );
                  return (
                    <tr key={bot.id} className="border-b last:border-0">
                      <td className="px-4 py-3 text-sm font-mono">{bot.id}</td>
                      <td className="px-4 py-3 text-sm font-medium">{bot.name}</td>
                      <td className="px-4 py-3 text-sm">{bot.username ? `@${bot.username}` : "-"}</td>
                      <td className="px-4 py-3 font-mono text-sm text-muted-foreground">
                        {maskToken(bot.token)}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {stats.buttons} 按钮 / {stats.submenus} 子菜单 / {stats.depth} 层
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {(() => {
                          const runtime = resolveBotRuntime(String(bot.id), bot.config, runtimeGlobal);
                          return (
                            <div className="flex flex-col gap-1">
                              <span
                                className={`inline-flex w-fit rounded-full border px-2 py-0.5 text-xs ${
                                  runtime.mode === "webhook"
                                    ? "border-purple-200 bg-purple-50 text-purple-700"
                                    : "border-sky-200 bg-sky-50 text-sky-700"
                                }`}
                              >
                                {runtime.mode === "webhook" ? "Webhook" : "长轮询"}
                              </span>
                              <span
                                className={`inline-flex w-fit rounded-full border px-2 py-0.5 text-xs ${
                                  runtime.privacy
                                    ? "border-green-200 bg-green-50 text-green-700"
                                    : "border-gray-200 bg-gray-50 text-gray-500"
                                }`}
                              >
                                隐私{runtime.privacy ? "开" : "关"}
                              </span>
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-4 py-3">
                        <DeployStatusCell botId={String(bot.id)} />
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
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {formatDateTime(bot.updatedTime)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          {/* v2.3 部署改 confirm：明确部署范围（全部群组/频道），单群部署引流到仿真页 */}
                          <ConfirmDialog
                            title={`部署「${bot.name}」`}
                            description={`将上线/更新该机器人运行实例，并部署到其全部已登记群组/频道（生成/刷新邀请链接）。需要部署到单个群组，请到「仿真APP」页面使用分体部署按钮单独选择。`}
                            action={deployBotAction}
                            fields={{ id: String(bot.id) }}
                            trigger="🚀 部署"
                            triggerClassName="inline-flex h-8 items-center rounded-md border border-emerald-200 bg-emerald-50 px-3 text-sm font-medium text-emerald-700 hover:bg-emerald-100"
                            confirmLabel="确认部署"
                          />
                          {/* v2.3 功能配置（三按钮合一）：原「消息内嵌按钮 / 指令菜单 / 自定义键盘」
                              三个弹窗合并为同一「功能配置」弹窗（复刻 TGAPI 菜单和键盘，去掉
                              APP创建参数/消息配置，新增 加群验证 / 通用门禁 / 功能面板开关） */}
                          <FeatureConfigDialog
                            bot={{
                              id: String(bot.id),
                              name: bot.name,
                              username: bot.username,
                              enabled: bot.enabled,
                              config: bot.config,
                              menuConfig: bot.menuConfig,
                            }}
                            methods={verificationMethods.map((method) => ({
                              id: Number(method.id),
                              name: method.name,
                              enabled: method.enabled,
                              type: method.type,
                            }))}
                            library={visibleCommands.map((item) => ({
                              id: item.id,
                              name: item.name,
                              description: item.description,
                              intro: item.intro,
                              type: item.type,
                              scopeLabel: undefined,
                            }))}
                            trigger="⚙️ 功能配置"
                            triggerClassName="inline-flex h-8 items-center rounded-md border border-primary/50 px-3 text-sm text-primary hover:bg-primary/10"
                          />
                          <BotRuntimeDialog
                            bot={{
                              id: String(bot.id),
                              name: bot.name,
                              transportMode: profile.transportMode ?? "inherit",
                              privacySetting: profile.privacyModeSetting ?? "inherit",
                            }}
                            global={{
                              mode: runtimeGlobal.transportMode,
                              webhookBaseUrl: runtimeGlobal.webhookBaseUrl,
                              privacyEnabled: runtimeGlobal.privacyEnabled,
                            }}
                            resolved={(() => {
                              const runtime = resolveBotRuntime(String(bot.id), bot.config, runtimeGlobal);
                              return { mode: runtime.mode, privacy: runtime.privacy, isEdge };
                            })()}
                            trigger="🚚 运行配置"
                          />
                          <BotFormDialog
                            bot={{
                              id: String(bot.id),
                              name: bot.name,
                              token: bot.token,
                              username: bot.username,
                              enabled: bot.enabled,
                              config: bot.config,
                            }}
                            trigger="编辑"
                            triggerClassName="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-accent"
                          />
                          <ConfirmDialog
                            title={`删除机器人「${bot.name}」`}
                            description={`确定要删除机器人「${bot.name}」#ID ${String(bot.id)} 吗？运行实例将停止且删除后不可恢复！`}
                            action={deleteBotAction}
                            fields={{ id: String(bot.id) }}
                            trigger="删除"
                            triggerClassName="inline-flex h-8 items-center rounded-md border border-red-200 px-3 text-sm font-medium text-red-600 hover:bg-red-50"
                          />
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
    </div>
  );
}
