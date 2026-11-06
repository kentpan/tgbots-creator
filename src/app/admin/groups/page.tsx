import {
  listBots,
  listGroupBotAdmins,
  listGroupSettings,
  listVerificationMethods,
  type BotRow,
  type GroupBotAdminRow,
  type GroupSettingsRow,
} from "@/database/operations";
import { requirePermission } from "@/lib/auth";
import { FormDialog } from "@/components/admin/form-dialog";
import { inputClass, labelClass, selectClass } from "@/components/admin/form-styles";
import { SwitchField } from "@/components/admin/switch-field";
import { deleteGroupAction, saveGroupAction } from "./actions";
import { BotAdminsDialog } from "./bot-admins-dialog";

export const dynamic = "force-dynamic";

const NOTICES: Record<string, string> = {
  "1": "群组验证配置已保存",
  deleted: "群组验证配置已删除",
  botadmin: "机器人管理员权限已更新",
  "botadmin-removed": "机器人管理员已移除",
};

const ERRORS: Record<string, string> = {
  "invalid-chat-id": "Chat ID 必须是数字（群组 ID 通常为负数）",
  "invalid-method": "验证方式不合法",
  "method-required": "选择自定义验证码方式时必须绑定具体验证方法",
  botadmin: "机器人管理员操作失败",
};

function GroupFormDialog({
  methods,
  group,
  trigger,
  triggerClassName,
}: {
  methods: { id: string; name: string; enabled: boolean }[];
  group?: GroupSettingsRow;
  trigger: React.ReactNode;
  triggerClassName?: string;
}) {
  return (
    <FormDialog
      trigger={trigger}
      triggerClassName={triggerClassName}
      title={group ? `编辑群组配置 · ${group.chatTitle ?? group.chatId}` : "新增群组配置"}
      description="为群组选择验证方式：自动验证码（机器人发码，输入验证码加群）、人机验证码（WebApp）或自定义验证码（外部 API 核验）。"
      action={saveGroupAction}
      submitLabel="保存配置"
    >
      <input type="hidden" name="editing_chat_id" value={group ? String(group.chatId) : ""} />
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1">
          <label className={labelClass} htmlFor={`chat-id-${group?.chatId ?? "new"}`}>
            群组 Chat ID *
          </label>
          <input
            id={`chat-id-${group?.chatId ?? "new"}`}
            name="chat_id"
            type="text"
            required
            defaultValue={group ? String(group.chatId) : ""}
            placeholder="例如 -1001998877661"
            className={`font-mono ${inputClass}`}
          />
        </div>
        <div className="space-y-1">
          <label className={labelClass} htmlFor={`chat-title-${group?.chatId ?? "new"}`}>
            群组名称
          </label>
          <input
            id={`chat-title-${group?.chatId ?? "new"}`}
            name="chat_title"
            type="text"
            defaultValue={group?.chatTitle ?? ""}
            placeholder="群组备注名称"
            className={inputClass}
          />
        </div>
        <div className="space-y-1">
          <label className={labelClass} htmlFor={`method-${group?.chatId ?? "new"}`}>
            验证方式
          </label>
          <select
            id={`method-${group?.chatId ?? "new"}`}
            name="method"
            defaultValue={group?.method ?? "code_self"}
            className={selectClass}
          >
            <option value="code_self">自动验证码（输入验证码加群）</option>
            <option value="captcha">人机验证码（WebApp）</option>
            <option value="code_api">自定义验证码（外部 API）</option>
          </select>
        </div>
        <div className="space-y-1">
          <label className={labelClass} htmlFor={`method-id-${group?.chatId ?? "new"}`}>
            绑定验证方法（仅自定义验证码）
          </label>
          <select
            id={`method-id-${group?.chatId ?? "new"}`}
            name="method_id"
            defaultValue={group?.methodId ? String(group.methodId) : ""}
            className={selectClass}
          >
            <option value="">不绑定</option>
            {methods.map((method) => (
              <option key={method.id} value={method.id}>
                #{method.id} {method.name}（{method.enabled ? "启用" : "停用"}）
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label className={labelClass} htmlFor={`timeout-${group?.chatId ?? "new"}`}>
            验证超时（秒）
          </label>
          <input
            id={`timeout-${group?.chatId ?? "new"}`}
            name="timeout_seconds"
            type="number"
            min={30}
            defaultValue={group?.timeoutSeconds ?? 300}
            className={inputClass}
          />
        </div>
        <div className="space-y-1">
          <label className={labelClass} htmlFor={`attempts-${group?.chatId ?? "new"}`}>
            最大尝试次数
          </label>
          <input
            id={`attempts-${group?.chatId ?? "new"}`}
            name="max_attempts"
            type="number"
            min={1}
            defaultValue={group?.maxAttempts ?? 3}
            className={inputClass}
          />
        </div>
        <div className="space-y-1 md:col-span-2">
          <label className={labelClass} htmlFor={`prompt-${group?.chatId ?? "new"}`}>
            验证码提示语（支持回车换行，仿真屏与 Telegram APP 中所见即所得）
          </label>
          <textarea
            id={`prompt-${group?.chatId ?? "new"}`}
            name="prompt_text"
            rows={4}
            defaultValue={group?.promptText ?? ""}
            placeholder={"🔐 请回复本消息并输入验证码完成验证\n\n可多行输入，换行在机器人私聊消息中原样展示"}
            className={`${inputClass} resize-y leading-relaxed`}
          />
        </div>
        <div className="space-y-1">
          <label className={labelClass} htmlFor={`success-${group?.chatId ?? "new"}`}>
            验证成功提示语
          </label>
          <input
            id={`success-${group?.chatId ?? "new"}`}
            name="success_text"
            type="text"
            defaultValue={group?.successText ?? ""}
            placeholder="✅ 验证成功，欢迎加入！"
            className={inputClass}
          />
        </div>
        <div className="space-y-1">
          <label className={labelClass} htmlFor={`failure-${group?.chatId ?? "new"}`}>
            验证失败提示语
          </label>
          <input
            id={`failure-${group?.chatId ?? "new"}`}
            name="failure_text"
            type="text"
            defaultValue={group?.failureText ?? ""}
            placeholder="❌ 验证码错误，请重试。"
            className={inputClass}
          />
        </div>
      </div>
      <SwitchField
        name="enabled"
        label="启用该群组验证配置"
        description="关闭后该群组的加群申请将不会被自动验证。"
        defaultChecked={group ? group.enabled : true}
        id={`enabled-${group?.chatId ?? "new"}`}
      />
      <SwitchField
        name="privacy_mode"
        label="隐私模式（Privacy Mode）"
        description="开启：验证码必须以「回复验证问题消息」的方式提交（stateless-question），机器人在 Telegram 隐私模式开启的群组中无需任何额外权限即可完成验证。关闭：宽松模式，任意文本消息都会触发验证码校验，需要机器人已关闭隐私模式或为群管理员。"
        defaultChecked={group ? group.privacyMode : true}
        id={`privacy-${group?.chatId ?? "new"}`}
      />
      <SwitchField
        name="kick_direct_joins"
        label="直连入群超时/失败踢出（默认关闭）"
        description="针对通过公开邀请链接/被拉入群的「已有用户」：开启后，验证超时或尝试次数用尽将自动移出群组（ban+unban，可重新申请）；关闭（默认）则保留在群内，仅失效本次验证并恢复发言权限。经入群申请链接加入的用户不受此开关影响。"
        defaultChecked={group ? group.kickDirectJoins : false}
        id={`kick-direct-${group?.chatId ?? "new"}`}
      />
    </FormDialog>
  );
}

export default async function GroupsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string; message?: string }>;
}) {
  await requirePermission("groups:view");
  const params = await searchParams;
  const [groups, methods, bots, botAdmins] = await Promise.all([
    listGroupSettings(),
    listVerificationMethods(),
    listBots(),
    listGroupBotAdmins(),
  ]);

  const botOptions = bots.map((bot: BotRow) => ({
    id: String(bot.id),
    name: bot.name,
    username: bot.username,
  }));

  const adminsByChat = new Map<string, GroupBotAdminRow[]>();
  for (const admin of botAdmins) {
    const key = String(admin.chatId);
    adminsByChat.set(key, [...(adminsByChat.get(key) ?? []), admin]);
  }
  const botNameById = new Map(botOptions.map((bot) => [bot.id, bot]));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">群组管理</h1>
          <p className="text-sm text-muted-foreground">
            为每个群组配置验证方式，并可将已接入的机器人设为群管理员。
          </p>
        </div>
        <GroupFormDialog
          methods={methods.map((method) => ({
            id: String(method.id),
            name: method.name,
            enabled: method.enabled,
          }))}
          trigger="+ 新增群组配置"
          triggerClassName="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        />
      </div>

      {params.saved && NOTICES[params.saved] ? (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          {NOTICES[params.saved]}
          {params.message ? (
            <span className="mt-1 block text-xs leading-relaxed text-green-800">{params.message}</span>
          ) : null}
        </div>
      ) : null}
      {params.error && ERRORS[params.error] ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {ERRORS[params.error]}
          {params.message ? `：${params.message}` : ""}
        </div>
      ) : null}

      <div className="rounded-xl border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-sm text-muted-foreground">
                <th className="px-4 py-3 font-medium">Chat ID</th>
                <th className="px-4 py-3 font-medium">群组名称</th>
                <th className="px-4 py-3 font-medium">验证方式</th>
                <th className="px-4 py-3 font-medium">超时（秒）</th>
                <th className="px-4 py-3 font-medium">最大尝试</th>
                <th className="px-4 py-3 font-medium">机器人管理员</th>
                <th className="px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {groups.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    还没有群组配置，点击右上角「新增群组配置」
                  </td>
                </tr>
              ) : (
                groups.map((group) => {
                  const chatKey = String(group.chatId);
                  const chatAdmins = adminsByChat.get(chatKey) ?? [];
                  return (
                    <tr key={chatKey} className="border-b last:border-0">
                      <td className="px-4 py-3 font-mono text-sm">{chatKey}</td>
                      <td className="px-4 py-3 text-sm">{group.chatTitle ?? "-"}</td>
                      <td className="px-4 py-3 text-sm">
                        {group.method === "code_api"
                          ? `自定义验证码（方法 #${String(group.methodId ?? 0)}）`
                          : group.method === "code_self"
                            ? "自动验证码（输入验证码加群）"
                            : "人机验证码（WebApp）"}
                      </td>
                      <td className="px-4 py-3 text-sm">{group.timeoutSeconds}</td>
                      <td className="px-4 py-3 text-sm">{group.maxAttempts}</td>
                      <td className="px-4 py-3 text-sm">
                        {chatAdmins.length === 0
                          ? "-"
                          : chatAdmins
                              .map((admin) => botNameById.get(String(admin.botId))?.name ?? `#${String(admin.botId)}`)
                              .join("、")}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full border px-2 py-0.5 text-sm ${
                            group.enabled
                              ? "border-green-200 bg-green-50 text-green-700"
                              : "border-gray-200 bg-gray-50 text-gray-500"
                          }`}
                        >
                          {group.enabled ? "启用" : "停用"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <GroupFormDialog
                            methods={methods.map((method) => ({
                              id: String(method.id),
                              name: method.name,
                              enabled: method.enabled,
                            }))}
                            group={group}
                            trigger="编辑"
                            triggerClassName="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-accent"
                          />
                          <BotAdminsDialog
                            chatId={chatKey}
                            bots={botOptions}
                            requireApproval={group.requireApproval}
                            admins={chatAdmins.map((admin) => {
                              let rights: Record<string, boolean> = {};
                              try {
                                rights = JSON.parse(admin.rights) as Record<string, boolean>;
                              } catch {
                                rights = {};
                              }
                              const bot = botNameById.get(String(admin.botId));
                              return {
                                id: String(admin.id),
                                botId: String(admin.botId),
                                botName: bot?.name ?? `机器人 #${String(admin.botId)}`,
                                botUsername: bot?.username ?? null,
                                rights,
                              };
                            })}
                            trigger="🤖 机器人管理员"
                            triggerClassName="inline-flex h-8 items-center rounded-md border border-primary/50 px-3 text-sm text-primary hover:bg-primary/10"
                          />
                          <form action={deleteGroupAction}>
                            <input type="hidden" name="chat_id" value={chatKey} />
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
