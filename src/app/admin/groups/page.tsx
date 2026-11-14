import {
  listBots,
  listGroupBotAdmins,
  listGroupSettings,
  type BotRow,
  type GroupBotAdminRow,
} from "@/database/operations";
import { requirePermission } from "@/lib/auth";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { deleteGroupAction } from "./actions";
import { BotAdminsDialog } from "./bot-admins-dialog";
import { InviteLinksDialog } from "./invite-links-dialog";

export const dynamic = "force-dynamic";

export default async function GroupsPage() {
  await requirePermission("groups:view");
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
            群组审核策略、验证文案与验证方式统一在仿真 APP → 群组信息中配置；此处仅管理机器人管理员权限、邀请链接与群组登记。
          </p>
        </div>
        <a href="/admin/bots/testing" className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90">在仿真 APP 中配置群组</a>
      </div>

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
                    尚未发现真实群组。请先在仿真 APP 中同步真实群组。
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
                            title={`删除群组登记 · ${group.chatTitle ?? chatKey}`}
                            description={`将删除该群组的本地设置与全部机器人关联记录（Chat ID ${chatKey}），Telegram 侧群组本身不受影响。此操作不可撤销，确定继续？`}
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
