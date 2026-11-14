import {
  listBots,
  listGroupBotAdmins,
  listGroupSettings,
  type BotRow,
  type GroupBotAdminRow,
  type GroupSettingsRow,
} from "@/database/operations";
import { parseBotFeatureConfig } from "@/services/bot-feature-config";
import { requirePermission } from "@/lib/auth";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { FormDialog } from "@/components/admin/form-dialog";
import { inputClass, labelClass, selectClass } from "@/components/admin/form-styles";
import { SwitchField } from "@/components/admin/switch-field";
import { deleteGroupAction, saveGroupAction } from "./actions";
import { BotAdminsDialog } from "./bot-admins-dialog";
import { InviteLinksDialog } from "./invite-links-dialog";

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
  joinVerifyCandidates,
  group,
  trigger,
  triggerClassName,
}: {
  joinVerifyCandidates: { id: string; name: string }[];
  group?: GroupSettingsRow;
  trigger: React.ReactNode;
  triggerClassName?: string;
}) {
  return (
    <FormDialog
      trigger={trigger}
      triggerClassName={triggerClassName}
      title={group ? `编辑群组配置 · ${group.chatTitle ?? group.chatId}` : "新增群组配置"}
      description="群级配置：群名 / 验证文案 / 新成员审核 / 自动审核机器人。验证方式与超时/次数在机器人的「功能配置」弹窗中配置（机器人级）。"
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
        label="隐私模式（机器人在群里怎么收验证码）"
        description="开启（默认）：入群者必须「回复」机器人发出的验证消息来提交验证码 —— 机器人只收得到回复，不需要读取群内普通消息的权限，BotFather 默认隐私模式开着即可正常验证。关闭（宽松）：入群者直接在群里发验证码也能通过，但机器人必须能读到群内全部消息（需在 BotFather 关闭隐私模式，或将机器人设为群管理员），否则机器人收不到消息、验证无法进行。"
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
      <SwitchField
        name="reply_code_in_group"
        label="群内回复输码快速验证（默认关闭）"
        description="仅群内验证渠道且验证方式为自动验证码/自定义验证码时生效：群内发送验证提示后输入框自动定位到回复态，成员直接回复输码即可（一次性验证码短暂可见）；验证结束/失败后机器人自动删除验证提示与验证码消息（需机器人具备「删除消息」管理员权限）。关闭（默认）时群内输码只能通过验证网页或点选按钮，输入内容其他成员不可见。"
        defaultChecked={group ? group.replyCodeInGroup : false}
        id={`reply-code-${group?.chatId ?? "new"}`}
      />
      <SwitchField
        name="require_approval"
        label="新成员审核（审批制入群）"
        description="开启后，本系统为支持申请制的超级群生成 creates_join_request 邀请链接。申请事件由下方指定机器人按其模式处理（验证码验证或直接通过），未指定机器人则由管理员人工审批。该开关不改变 Telegram 外部普通邀请链接或公开用户名入口本身的类型。"
        defaultChecked={group ? group.requireApproval : false}
        id={`require-approval-${group?.chatId ?? "new"}`}
      />
      <div className="space-y-1">
        <label className={labelClass} htmlFor={`jv-bot-${group?.chatId ?? "new"}`}>
          自动审核机器人（默认手动审核）
        </label>
        <select
          id={`jv-bot-${group?.chatId ?? "new"}`}
          name="join_verify_bot_id"
          defaultValue={group?.joinVerifyBotId ? String(group.joinVerifyBotId) : ""}
          className={selectClass}
        >
          <option value="">手动审核（在「加群申请」页人工审批）</option>
          {joinVerifyCandidates.map((bot) => (
            <option key={bot.id} value={bot.id}>
              {bot.name}（自动验证加群申请）
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          列表显示已启用「自动响应加群申请」且已选择验证码验证或直接通过模式的机器人；机器人未出现？到
          <a href="/admin/bots" className="mx-1 text-primary underline">机器人管理 → 功能配置</a>
          开启「自动响应加群申请」并选择验证方式，然后点「部署」更新运行实例。
        </p>
      </div>
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
  const [groups, bots, botAdmins] = await Promise.all([
    listGroupSettings(),
    listBots(),
    listGroupBotAdmins(),
  ]);

  const botOptions = bots.map((bot: BotRow) => ({
    id: String(bot.id),
    name: bot.name,
    username: bot.username,
  }));

  // v2.3 自动审核机器人候选：bots.config.joinVerify.enabled 的机器人
  const joinVerifyCandidates = bots
    .filter((bot: BotRow) => {
      const feature = parseBotFeatureConfig(bot.config, false);
      return feature.joinVerify.enabled && (feature.joinVerify.mode === "direct" || feature.joinVerify.methodId);
    })
    .map((bot: BotRow) => ({ id: String(bot.id), name: bot.name }));

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
            为每个群组配置验证文案、新成员审核与自动审核机器人，并可将已接入的机器人设为群管理员；验证方式在机器人「功能配置」弹窗中配置。
          </p>
        </div>
        <GroupFormDialog
          joinVerifyCandidates={joinVerifyCandidates}
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
                <th className="px-4 py-3 font-medium">新成员审核</th>
                <th className="px-4 py-3 font-medium">自动审核机器人</th>
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
                        <span
                          className={`inline-flex rounded-full border px-2 py-0.5 text-xs ${
                            group.requireApproval
                              ? "border-amber-200 bg-amber-50 text-amber-700"
                              : "border-gray-200 bg-gray-50 text-gray-500"
                          }`}
                        >
                          {group.requireApproval ? "审核开" : "审核关"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {group.joinVerifyBotId
                          ? botNameById.get(String(group.joinVerifyBotId))?.name ?? `#${String(group.joinVerifyBotId)}`
                          : "手动审核"}
                      </td>
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
                            joinVerifyCandidates={joinVerifyCandidates}
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
                          <InviteLinksDialog
                            chatId={chatKey}
                            chatTitle={group.chatTitle ?? ""}
                            bots={chatAdmins.map((admin) => ({
                              id: String(admin.botId),
                              name:
                                botNameById.get(String(admin.botId))?.name ??
                                `机器人 #${String(admin.botId)}`,
                            }))}
                            trigger="🔗 邀请链接"
                            triggerClassName="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-accent"
                          />
                          <ConfirmDialog
                            trigger="删除"
                            triggerClassName="inline-flex h-8 items-center rounded-md border border-red-200 px-3 text-sm font-medium text-red-600 hover:bg-red-50"
                            title={`删除群组验证配置 · ${group.chatTitle ?? chatKey}`}
                            description={`将删除该群组的验证配置与全部机器人关联记录（Chat ID ${chatKey}），Telegram 侧群组本身不受影响。此操作不可撤销，确定继续？`}
                            action={deleteGroupAction}
                            fields={{ chat_id: chatKey }}
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
