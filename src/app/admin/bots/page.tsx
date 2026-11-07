import { listBots, listBotCommands, listDeveloperAccounts, listGroupSettings } from "@/database/operations";
import { getStorage } from "@/database/bindings";
import { countMenuStats, parseBotMenuConfig } from "@/services/menu-config";
import { getTelegramRuntimeSettings, resolveBotRuntime } from "@/services/bot-transport";
import { isEdgeRuntime } from "@/lib/telegram/runtime-mode";
import { parseBotProfile, parseBotPrivacyMode } from "@/bot/multi-runtime";
import { parseMirrorConfig } from "@/bot/mirror/types";
import { requirePermission } from "@/lib/auth";
import { deleteBotAction, syncBotMenuAction, testBotAction } from "./actions";
import { BotFormDialog } from "./bot-form-dialog";
import { MirrorFormDialog } from "./mirror-form-dialog";
import { CommandMenuDialog } from "./command-menu-dialog";
import { MenuDesignerDialog } from "./menu-designer-dialog";
import { BotRuntimeDialog } from "./bot-runtime-dialog";
import { BotCreateGuide } from "./bot-create-guide";
import { FormDialog } from "@/components/admin/form-dialog";
import { inputClass, labelClass } from "@/components/admin/form-styles";

export const dynamic = "force-dynamic";

const NOTICES: Record<string, string> = {
  "1": "机器人已保存",
  menu: "消息内嵌按钮配置已保存，运行实例已热更新",
  sync: "消息内嵌按钮已真实同步到群组",
  deleted: "机器人已删除",
  profile: "官方资料已应用到机器人",
  commands: "指令菜单已保存并同步到 Telegram",
};

const ERRORS: Record<string, string> = {
  "name-required": "请填写备注名称",
  "invalid-token": "Token 格式不合法（应为 123456789:AAxxxx 形式）",
  "duplicate-token": "该 Token 已存在",
  "invalid-id": "机器人不存在",
  "mirror-target-required": "请填写目标 bot 用户名",
  "mirror-verify-bot-required": "验证绑定模式必须选择绑定的加群验证机器人",
  "invalid-menu": "消息内嵌按钮配置不合法",
  "invalid-commands": "指令菜单数据不合法，请重试",
  "runtime": "机器人运行配置已保存并热应用",
};

function formatDateTime(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function maskToken(token: string): string {
  if (token.length <= 12) return token;
  return `${token.slice(0, 8)}••••${token.slice(-4)}`;
}

export default async function BotsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string; test?: string; sync?: string; message?: string }>;
}) {
  await requirePermission("bots:view");
  const params = await searchParams;
  const [bots, groups, builtinCommands, customCommands, developerAccounts] = await Promise.all([
    listBots(),
    listGroupSettings(),
    listBotCommands({ type: "builtin", enabledOnly: true }),
    listBotCommands({ type: "custom", enabledOnly: true }),
    listDeveloperAccounts(),
  ]);
  const developerAccountOptions = developerAccounts.map((account) => ({
    id: String(account.id),
    apiId: String(account.apiId),
    phone: account.phone ?? "",
    remark: account.remark ?? "",
  }));
  const botOptions = bots.map((bot) => ({
    id: String(bot.id),
    name: bot.name,
    username: bot.username,
  }));
  const commandLibrary = [...builtinCommands.rows, ...customCommands.rows].map((row) => ({
    id: String(row.id),
    name: row.name,
    description: row.description,
    intro: row.intro,
    type: row.type,
  }));
  const runtimeGlobal = await getTelegramRuntimeSettings();
  const isEdge = isEdgeRuntime();

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
          <MirrorFormDialog
            developerAccounts={developerAccountOptions}
            bots={botOptions}
            trigger="🪞 新增镜像机器人"
            triggerClassName="inline-flex h-10 items-center rounded-md border border-primary/50 px-4 text-sm font-medium text-primary hover:bg-primary/10"
          />
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
      {params.test === "ok" ? (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          连接成功：{params.message}
        </div>
      ) : null}
      {params.test === "fail" ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          连接失败：{params.message}
        </div>
      ) : null}
      {params.sync === "fail" ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          同步失败：{params.message}
        </div>
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
                <th className="px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium">更新时间</th>
                <th className="px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {bots.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    还没有机器人，点击右上角「从零创建机器人」按引导创建，或「新增机器人」直接接入 Token
                  </td>
                </tr>
              ) : (
                bots.map((bot) => {
                  const stats = countMenuStats(parseBotMenuConfig(bot.menuConfig).root);
                  const profile = parseBotProfile(bot.config);
                  const mirrorCfg = parseMirrorConfig(bot.config);
                  return (
                    <tr key={bot.id} className="border-b last:border-0">
                      <td className="px-4 py-3 text-sm font-mono">{bot.id}</td>
                      <td className="px-4 py-3 text-sm font-medium">
                        {bot.name}
                        {mirrorCfg ? (
                          <span className="ml-2 inline-flex items-center rounded-full border border-fuchsia-200 bg-fuchsia-50 px-2 py-0.5 text-xs font-medium text-fuchsia-700">
                            镜像 → @{mirrorCfg.targetBot}
                          </span>
                        ) : null}
                      </td>
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
                          {mirrorCfg ? (
                            <MirrorFormDialog
                              bot={{
                                id: String(bot.id),
                                name: bot.name,
                                token: bot.token,
                                username: bot.username,
                                enabled: bot.enabled,
                                config: bot.config,
                              }}
                              developerAccounts={developerAccountOptions}
                              bots={botOptions}
                              trigger="🪞 镜像配置"
                              triggerClassName="inline-flex h-8 items-center rounded-md border border-primary/50 px-3 text-sm text-primary hover:bg-primary/10"
                            />
                          ) : (
                            <>
                              <MenuDesignerDialog
                                bot={{
                                  id: String(bot.id),
                                  name: bot.name,
                                  menuConfig: bot.menuConfig,
                                  menuText: bot.menuText,
                                  username: bot.username,
                                  privacyMode: parseBotPrivacyMode(profile),
                                }}
                                groups={groups.map((group) => ({
                                  chatId: String(group.chatId),
                                  chatTitle: group.chatTitle,
                                }))}
                                storageKind={getStorage().kind}
                                trigger="⚙️ 消息内嵌按钮"
                                triggerClassName="inline-flex h-8 items-center rounded-md border border-primary/50 px-3 text-sm text-primary hover:bg-primary/10"
                              />
                              <CommandMenuDialog
                                bot={{
                                  id: String(bot.id),
                                  name: bot.name,
                                  privacyMode: parseBotPrivacyMode(profile),
                                  selectedCommandIds: Array.isArray(profile.commandIds)
                                    ? profile.commandIds
                                    : [],
                                }}
                                library={commandLibrary}
                                trigger="⌨️ 指令菜单"
                                triggerClassName="inline-flex h-8 items-center rounded-md border border-primary/50 px-3 text-sm text-primary hover:bg-primary/10"
                              />
                            </>
                          )}
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
                          {mirrorCfg ? null : (
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
                          )}
                          <form action={testBotAction}>
                            <input type="hidden" name="id" value={String(bot.id)} />
                            <button
                              type="submit"
                              className="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-accent"
                            >
                              测试
                            </button>
                          </form>
                          <FormDialog
                            trigger="同步"
                            triggerClassName="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-accent"
                            title={`同步消息内嵌按钮 · ${bot.name}`}
                            description="把当前已保存的消息内嵌按钮以真实消息发送到目标群组，群成员可立即点击使用。"
                            action={syncBotMenuAction}
                            submitLabel="立即同步"
                          >
                            <input type="hidden" name="id" value={String(bot.id)} />
                            <div className="space-y-1">
                              <label className={labelClass} htmlFor={`sync-${bot.id}`}>
                                群组 Chat ID
                              </label>
                              <input
                                id={`sync-${bot.id}`}
                                name="chat_id"
                                required
                                list={`sync-group-list-${bot.id}`}
                                placeholder="-1001998877661"
                                className={inputClass}
                              />
                              <datalist id={`sync-group-list-${bot.id}`}>
                                {groups.map((group) => (
                                  <option key={String(group.chatId)} value={String(group.chatId)}>
                                    {group.chatTitle ?? "群组"}
                                  </option>
                                ))}
                              </datalist>
                            </div>
                          </FormDialog>
                          <form action={deleteBotAction}>
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
    </div>
  );
}
