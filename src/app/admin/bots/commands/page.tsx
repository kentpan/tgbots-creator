import Link from "next/link";
import { formatBeijingDateTime } from "@/utils/datetime";
import {
  listBots,
  listBotCommands,
  listGroupSettings,
  type BotCommandRow,
  type BotCommandType,
} from "@/database/operations";
import { requirePermission } from "@/lib/auth";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { CommandFormDialog } from "./command-form-dialog";
import {
  deleteBotCommandAction,
  moveBotCommandAction,
  toggleBotCommandAction,
} from "./actions";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

const NOTICES: Record<string, string> = {
  "1": "指令已保存",
  deleted: "指令已删除",
};

const ERRORS: Record<string, string> = {
  "invalid-name": "指令名不合法：仅允许 1-32 位小写字母、数字与下划线",
  "invalid-description": "指令描述不能为空且不超过 256 字符",
  "duplicate-name": "同名指令已存在",
  "invalid-id": "指令不存在或已被删除",
  "invalid-scope": "指令归属不合法：机器人私有与群组私有不能同时选择",
  "invalid-scope-target": "归属对象不存在：请重新选择所属机器人或群组",
};

const TABS: { key: BotCommandType; label: string }[] = [
  { key: "builtin", label: "内置指令" },
  { key: "custom", label: "自定义指令" },
];

function pageHref(tab: BotCommandType, page: number): string {
  return `/admin/bots/commands?tab=${tab}&page=${page}`;
}

export default async function BotCommandsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; page?: string; saved?: string; error?: string }>;
}) {
  await requirePermission("bots:view");
  const params = await searchParams;
  const tab: BotCommandType = params.tab === "custom" ? "custom" : "builtin";
  const page = Math.max(1, Number(params.page ?? "1") || 1);

  const result = await listBotCommands({ type: tab, page, pageSize: PAGE_SIZE });
  // 归属列映射（v2.1.13）：bot_id → 机器人名，group_id → 群组名
  const [bots, groups] = await Promise.all([listBots(), listGroupSettings()]);
  const botNameById = new Map(bots.map((bot) => [String(bot.id), bot.name]));
  const groupTitleById = new Map(groups.map((group) => [String(group.chatId), group.chatTitle]));
  const scopeBotOptions = bots.map((bot) => ({ id: String(bot.id), name: bot.name }));
  const scopeGroupOptions = groups.map((group) => ({
    chatId: String(group.chatId),
    chatTitle: group.chatTitle,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">指令管理</h1>
          <p className="text-sm text-muted-foreground">
            维护机器人的内置指令与自定义指令；在「机器人管理」列表点击「指令菜单」即可把指令真实同步到 Telegram 用户指令菜单。
          </p>
        </div>
        <CommandFormDialog
          type={tab}
          bots={scopeBotOptions}
          groups={scopeGroupOptions}
          trigger={`+ 新增${tab === "builtin" ? "内置" : "自定义"}指令`}
          triggerClassName="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        />
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

      {/* 内置 / 自定义 双 Tab（服务端渲染切换） */}
      <div className="flex gap-1 rounded-lg border bg-card p-1">
        {TABS.map((item) => (
          <Link
            key={item.key}
            href={pageHref(item.key, 1)}
            className={`flex-1 rounded-md px-4 py-2 text-center text-sm font-medium transition-colors ${
              tab === item.key
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            }`}
          >
            {item.label}
          </Link>
        ))}
      </div>

      {tab === "builtin" ? <BuiltinIntro /> : <CustomGuide />}

      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full min-w-[920px] text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">ID</th>
              <th className="px-4 py-3 font-medium">指令</th>
              <th className="px-4 py-3 font-medium">描述</th>
              <th className="px-4 py-3 font-medium">{tab === "builtin" ? "中文介绍" : "详细介绍"}</th>
              <th className="px-4 py-3 font-medium">排序</th>
              <th className="px-4 py-3 font-medium">归属</th>
              <th className="px-4 py-3 font-medium">状态</th>
              <th className="px-4 py-3 font-medium">更新时间</th>
              <th className="px-4 py-3 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {result.rows.map((row, index) => (
              <CommandRow
                key={String(row.id)}
                row={row}
                tab={tab}
                page={result.page}
                isFirst={index === 0 && page === 1}
                isLast={index === result.rows.length - 1 && page >= result.totalPages}
                botNameById={botNameById}
                groupTitleById={groupTitleById}
                scopeBotOptions={scopeBotOptions}
                scopeGroupOptions={scopeGroupOptions}
              />
            ))}
            {result.rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-10 text-center text-muted-foreground">
                  暂无{tab === "builtin" ? "内置" : "自定义"}指令，点击右上角新增。
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <Pagination tab={tab} page={result.page} totalPages={result.totalPages} total={result.total} />
    </div>
  );
}

/** 内置指令说明卡片 */
function BuiltinIntro() {
  return (
    <div className="rounded-xl border bg-card p-5 text-sm leading-relaxed">
      <h2 className="mb-2 font-semibold">什么是内置指令？</h2>
      <p className="text-muted-foreground">
        内置指令是机器人官方提供、由系统代码真实实现的指令目录（v1.1.0 起共 23 条）：除
        <code className="mx-1 rounded bg-muted px-1">/start</code>
        <code className="mx-1 rounded bg-muted px-1">/help</code>
        <code className="mx-1 rounded bg-muted px-1">/stats</code>
        <code className="mx-1 rounded bg-muted px-1">/api</code>
        等基础指令外，还涵盖主菜单（/menu）、用户与 ID 查询（/info /id）、链路诊断（/ping /time）、群规与举报（/rules /report）以及完整的群管工具
        （/ban /unban /mute /unmute /kick /warn /warns /pin），每条都附有中文介绍与真实 grammY 处理器。
        排序按使用频率排列（越常用越靠前），可通过 ↑↓ 按钮随时调整；只有「已启用」的指令才会注册到机器人并同步到 Telegram 指令菜单。
        Telegram 对指令名的硬性限制：1-32 个字符，仅小写字母（a-z）、数字（0-9）与下划线（_）。
      </p>
    </div>
  );
}

/** 自定义指令详细介绍 + 创建步骤卡片 */
function CustomGuide() {
  const steps = [
    "点击右上角「+ 新增自定义指令」，填写指令名（1-32 位小写字母/数字/下划线，如 price、faq_rules）。",
    "填写指令描述（1-256 字符）——它将显示在用户的 Telegram 指令菜单中，建议简明扼要。",
    "填写详细介绍：机器人被调用时会原样回复这段文本，可用于价格表、群规、FAQ 等内容。",
    "保持「启用」状态并保存；如需临时下线某条指令，可在列表中切换状态开关。",
    "进入「机器人管理」列表，点击目标机器人的「指令菜单」按钮，在浮层「自定义指令」页签中勾选新指令并保存，机器人会立即注册指令并调用 setMyCommands 同步到 Telegram。",
  ];
  return (
    <div className="rounded-xl border bg-card p-5 text-sm leading-relaxed">
      <h2 className="mb-2 font-semibold">什么是自定义指令？如何创建？</h2>
      <p className="mb-3 text-muted-foreground">
        自定义指令由管理员在后台自由创建，无需写代码：机器人运行时会真实注册这些指令
        （基于 grammY 指令插件 <code className="rounded bg-muted px-1">@grammyjs/commands</code>），
        用户在 Telegram 中输入对应指令时机器人自动回复详细介绍文本。
        指令匹配行为受机器人「隐私模式」开关控制：开启时仅匹配消息开头的标准
        <code className="rounded bg-muted px-1">/指令</code>；关闭时支持消息任意位置与
        <code className="rounded bg-muted px-1">/指令@机器人名</code> 定向写法。
      </p>
      <ol className="list-decimal space-y-1.5 pl-5 text-muted-foreground">
        {steps.map((step, index) => (
          <li key={index}>{step}</li>
        ))}
      </ol>
    </div>
  );
}

/** 归属徽标（v2.1.13）：全局 / 机器人私有 / 群组私有，机器人与群组两个维度绝不混淆 */
function CommandScopeBadge({
  row,
  botNameById,
  groupTitleById,
}: {
  row: BotCommandRow;
  botNameById: Map<string, string>;
  groupTitleById: Map<string, string | null>;
}) {
  if (row.botId !== null) {
    const name = botNameById.get(String(row.botId)) ?? `ID ${String(row.botId)}`;
    return (
      <span className="inline-flex items-center rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700">
        🤖 {name} 私有
      </span>
    );
  }
  if (row.groupId !== null) {
    const title = groupTitleById.get(String(row.groupId)) ?? `ID ${String(row.groupId)}`;
    return (
      <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
        👥 {title}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
      🌐 全局
    </span>
  );
}

function CommandRow({
  row,
  tab,
  page,
  isFirst,
  isLast,
  botNameById,
  groupTitleById,
  scopeBotOptions,
  scopeGroupOptions,
}: {
  row: BotCommandRow;
  tab: BotCommandType;
  page: number;
  isFirst: boolean;
  isLast: boolean;
  botNameById: Map<string, string>;
  groupTitleById: Map<string, string | null>;
  scopeBotOptions: { id: string; name: string }[];
  scopeGroupOptions: { chatId: string; chatTitle: string | null }[];
}) {
  return (
    <tr className="align-top hover:bg-muted/20">
      <td className="px-4 py-3 text-muted-foreground">{String(row.id)}</td>
      <td className="px-4 py-3">
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">/{row.name}</code>
      </td>
      <td className="max-w-52 px-4 py-3">{row.description}</td>
      <td className="max-w-96 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
        <span className="line-clamp-3">{row.intro || "—"}</span>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1">
          <span className="inline-flex h-6 min-w-8 items-center justify-center rounded bg-muted px-1.5 text-xs text-muted-foreground">
            {row.sortOrder}
          </span>
          <form action={moveBotCommandAction}>
            <input type="hidden" name="id" value={String(row.id)} />
            <input type="hidden" name="direction" value="up" />
            <input type="hidden" name="tab" value={tab} />
            <input type="hidden" name="page" value={String(page)} />
            <button
              type="submit"
              title="上移（越常用的排越前面）"
              disabled={isFirst}
              className="inline-flex h-6 w-6 items-center justify-center rounded border text-xs hover:bg-accent disabled:opacity-30"
            >
              ↑
            </button>
          </form>
          <form action={moveBotCommandAction}>
            <input type="hidden" name="id" value={String(row.id)} />
            <input type="hidden" name="direction" value="down" />
            <input type="hidden" name="tab" value={tab} />
            <input type="hidden" name="page" value={String(page)} />
            <button
              type="submit"
              title="下移"
              disabled={isLast}
              className="inline-flex h-6 w-6 items-center justify-center rounded border text-xs hover:bg-accent disabled:opacity-30"
            >
              ↓
            </button>
          </form>
        </div>
      </td>
      <td className="px-4 py-3">
        <CommandScopeBadge row={row} botNameById={botNameById} groupTitleById={groupTitleById} />
      </td>
      <td className="px-4 py-3">
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
            row.enabled
              ? "bg-green-100 text-green-700"
              : "bg-gray-100 text-gray-500"
          }`}
        >
          {row.enabled ? "已启用" : "已停用"}
        </span>
      </td>
      <td className="px-4 py-3 text-xs text-muted-foreground">
        {formatBeijingDateTime(row.updatedTime)}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-2">
          <CommandFormDialog
            command={{
              id: String(row.id),
              type: row.type,
              name: row.name,
              description: row.description,
              intro: row.intro,
              enabled: row.enabled,
              sortOrder: row.sortOrder,
              botId: row.botId === null ? null : String(row.botId),
              groupId: row.groupId === null ? null : String(row.groupId),
            }}
            type={row.type}
            bots={scopeBotOptions}
            groups={scopeGroupOptions}
            trigger="编辑"
            triggerClassName="inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium hover:bg-accent"
          />
          <form action={toggleBotCommandAction}>
            <input type="hidden" name="id" value={String(row.id)} />
            <input type="hidden" name="tab" value={tab} />
            <input type="hidden" name="page" value={String(page)} />
            <button
              type="submit"
              className="inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium hover:bg-accent"
            >
              {row.enabled ? "停用" : "启用"}
            </button>
          </form>
          <ConfirmDialog
            title={`删除指令 /${row.name}`}
            description={`确认删除${row.type === "builtin" ? "内置" : "自定义"}指令 /${row.name} 吗？已应用该指令的机器人需重新同步指令菜单。`}
            action={deleteBotCommandAction}
            fields={{ id: String(row.id), tab }}
            trigger="删除"
            triggerClassName="inline-flex h-8 items-center rounded-md border border-red-200 px-3 text-xs font-medium text-red-600 hover:bg-red-50"
          />
        </div>
      </td>
    </tr>
  );
}

function Pagination({
  tab,
  page,
  totalPages,
  total,
}: {
  tab: BotCommandType;
  page: number;
  totalPages: number;
  total: number;
}) {
  return (
    <div className="flex items-center justify-between text-sm text-muted-foreground">
      <span>
        共 {total} 条 · 第 {page} / {totalPages} 页（每页 {PAGE_SIZE} 条）
      </span>
      <div className="flex items-center gap-2">
        {page > 1 ? (
          <Link
            href={pageHref(tab, page - 1)}
            className="inline-flex h-9 items-center rounded-md border px-3 text-xs font-medium hover:bg-accent"
          >
            上一页
          </Link>
        ) : (
          <span className="inline-flex h-9 items-center rounded-md border px-3 text-xs font-medium opacity-40">
            上一页
          </span>
        )}
        {page < totalPages ? (
          <Link
            href={pageHref(tab, page + 1)}
            className="inline-flex h-9 items-center rounded-md border px-3 text-xs font-medium hover:bg-accent"
          >
            下一页
          </Link>
        ) : (
          <span className="inline-flex h-9 items-center rounded-md border px-3 text-xs font-medium opacity-40">
            下一页
          </span>
        )}
      </div>
    </div>
  );
}
