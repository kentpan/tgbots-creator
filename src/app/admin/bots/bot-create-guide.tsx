"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { SelfContainedTabs } from "@/components/admin/self-contained-tabs";

/**
 * 从零创建机器人 · 全流程引导。
 * 步骤即 Tab（受控模式，支持「下一步」翻步）：每步含说明文案、可复制命令、
 * 外部链接（BotFather / 相关页面）与下一步指引。
 */

interface GuideStep {
  key: string;
  label: string;
  title: string;
  body: string[];
  command?: string;
  links?: { label: string; href: string }[];
  next: string;
}

const STEPS: GuideStep[] = [
  {
    key: "botfather",
    label: "1. 找到 BotFather",
    title: "打开官方机器人 @BotFather",
    body: [
      "所有 Telegram 机器人都由官方「机器人之父」@BotFather 创建和管理，它本身也是一个机器人。",
      "点击下方链接直接打开对话（需已登录 Telegram），或搜索 @BotFather。谨防仿冒：官方账号带蓝色认证徽标，且永远不会先向你索要密码。",
    ],
    links: [{ label: "打开 t.me/BotFather", href: "https://t.me/BotFather" }],
    next: "发送 /newbot",
  },
  {
    key: "newbot",
    label: "2. 发送 /newbot",
    title: "向 BotFather 发送创建命令",
    body: [
      "在对话框输入下方命令并发送，BotFather 会引导你完成两步设置：先取显示名，再取用户名。",
    ],
    command: "/newbot",
    next: "设置名称与用户名",
  },
  {
    key: "name",
    label: "3. 名称与用户名",
    title: "设置机器人名称与用户名",
    body: [
      "① 名称（name）：机器人的显示名称，如「TGuard 加群验证」，中文即可，随时可改。",
      "② 用户名（username）：全局唯一、必须以 bot 结尾（不区分大小写），如 tguard_verify_bot，5-32 个字符，仅字母/数字/下划线。",
      "两步都完成后，BotFather 会立刻回复一段包含 HTTP API Token 的消息 —— 这就是下一步要保管好的钥匙。",
    ],
    next: "保存 Token",
  },
  {
    key: "token",
    label: "4. 保存 Token",
    title: "复制并保管 Bot Token",
    body: [
      "BotFather 回复格式形如：123456789:AAHfiqksKZ8WbR5P3m4n8Xv2L9cD0aS1b2C（<数字ID>:<35位密钥>）。",
      "Token 等同于机器人的完全控制权，绝对不要泄露/提交到公开仓库；泄露后立即向 BotFather 发送 /revoke 换新。",
      "接下来把 Token 录入本系统：关闭本引导 → 返回「机器人管理」页 → 点右上角「+ 新增机器人」粘贴 Token 并保存。",
    ],
    links: [{ label: "BotFather 官方说明（Bots FAQ）", href: "https://core.telegram.org/bots/faq" }],
    next: "设置隐私模式",
  },
  {
    key: "privacy",
    label: "5. 隐私模式",
    title: "设置隐私模式（决定 bot 能看到什么）",
    body: [
      "隐私模式（Privacy Mode）只针对机器人，是 bot 级全局设置，在 BotFather 中配置（Bot API 无法修改）：",
      "• 开启（默认/推荐）：群聊中 bot 收不到普通消息，只接收 /命令、对其消息的回复、@bot 提及与服务消息 —— 适合验证类机器人。",
      "• 关闭：bot 接收群内全部消息 —— 适合关键词监听/统计类机器人。",
      "操作：向 BotFather 发送 /setprivacy → 选择你的机器人 → Enable（开启）/ Disable（关闭）。",
      "",
      "常见误区：隐私模式的方向是「bot 看不到用户」，而不是把用户消息藏起来 —— 群里其他人永远能看到普通群消息（Telegram 没有「对部分人隐藏」的机制）。",
      "要让「用户与 bot 的对话」对群里其他人完全不可见，唯一方式是把交互引到 bot 私聊：本系统生成的验证链接（t.me/<bot>?start=<token>）已内置私聊验证通道，验证码在私聊中输入，群里不可见。",
    ],
    command: "/setprivacy",
    links: [{ label: "Group Privacy 官方说明", href: "https://core.telegram.org/bots/features#privacy-mode" }],
    next: "加入群组",
  },
  {
    key: "group",
    label: "6. 加入群组",
    title: "把机器人加入群组并授予管理员",
    body: [
      "① 把机器人拉进目标群组（群设置 → 添加成员 → 搜索机器人用户名）。",
      "② 验证机器人需要管理员权限：设为管理员并勾选「删除消息」「邀请用户」「封禁用户」等权限（本系统「群组」页也可一键调用 promoteChatMember 授权）。",
      "③ 加入/授权成功后，回到「机器人测试」页点「同步真实群组」，系统会通过 bot token 的 getUpdates 拉取真实群组 chat_id 并登记（真实数据，无假数据）。",
    ],
    links: [
      { label: "前往 机器人测试（同步真实群组/仿真）", href: "/admin/bots/testing" },
      { label: "前往 群组管理（一键设管理员）", href: "/admin/groups" },
    ],
    next: "配置与部署",
  },
  {
    key: "deploy",
    label: "7. 配置与部署",
    title: "配置验证方式并部署",
    body: [
      "① 群组绑定验证方式：在「机器人测试」页选择群组 → 配置验证 API → 仿真屏全流程演练（申请加入 → 私聊输入验证码 → 入群欢迎）。",
      "② 运行模式：默认 Webhook（出站 API 走全局代理，入站由 Telegram 推送到公网回调地址）；Node 未配置回调地址时自动回退长轮询，也可在「运行配置」里按机器人显式指定。",
      "③ 一键部署到真实群组：测试页右上角「一键部署到真实群组」按引导把配置同步到真实群组。",
      "④ 如需公网访问（验证页/Webhook），在「系统设置」配置站点 Base URL 与 Telegram 代理（Node 环境默认开启内置代理直连 Bot API）。",
    ],
    links: [{ label: "前往 系统设置（代理/传输模式/隐私模式）", href: "/admin/settings" }],
    next: "完成 🎉",
  },
];

function CopyRow({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
      <code className="min-w-0 flex-1 truncate font-mono text-sm">{text}</code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border px-2 text-xs hover:bg-accent"
        aria-label="复制"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? "已复制" : "复制"}
      </button>
    </div>
  );
}

export function BotCreateGuide({
  trigger = "📖 从零创建机器人",
  triggerClassName = "inline-flex h-10 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent",
}: {
  trigger?: string;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [stepKey, setStepKey] = useState(STEPS[0].key);
  const index = Math.max(0, STEPS.findIndex((step) => step.key === stepKey));
  const step = STEPS[index];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" className={triggerClassName}>
          {trigger}
        </button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[88vh] flex-col overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <DialogTitle>从零创建机器人 · 全流程引导</DialogTitle>
          <DialogDescription>
            BotFather 创建 → Token 录入 → 隐私模式 → 入群授权 → 配置部署，共 {STEPS.length} 步；含可复制命令与直达链接。
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          <SelfContainedTabs
            ariaLabel="创建机器人步骤"
            activeKey={stepKey}
            onActiveKeyChange={setStepKey}
            items={STEPS.map((entry) => ({
              key: entry.key,
              label: entry.label,
              content: (
                <div className="space-y-3">
                  <h3 className="text-base font-semibold">{entry.title}</h3>
                  <div className="space-y-1.5">
                    {entry.body.map((line, lineIndex) =>
                      line ? (
                        <p key={lineIndex} className="text-sm leading-relaxed text-muted-foreground">
                          {line}
                        </p>
                      ) : (
                        <div key={lineIndex} className="h-1" />
                      ),
                    )}
                  </div>
                  {entry.command ? <CopyRow text={entry.command} /> : null}
                  {entry.links?.length ? (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {entry.links.map((link) => (
                        <a
                          key={link.href}
                          href={link.href}
                          target={link.href.startsWith("http") ? "_blank" : undefined}
                          rel={link.href.startsWith("http") ? "noreferrer" : undefined}
                          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-primary/50 px-3 text-sm text-primary hover:bg-primary/10"
                        >
                          {link.label}
                          {link.href.startsWith("http") ? <ExternalLink className="h-3.5 w-3.5" /> : null}
                        </a>
                      ))}
                    </div>
                  ) : null}
                </div>
              ),
            }))}
          />
        </div>
        <div className="flex shrink-0 items-center justify-between gap-2 border-t bg-muted/30 px-6 py-3">
          <button
            type="button"
            disabled={index === 0}
            onClick={() => setStepKey(STEPS[Math.max(0, index - 1)].key)}
            className="inline-flex h-9 items-center rounded-md border px-4 text-sm hover:bg-accent disabled:opacity-40"
          >
            上一步
          </button>
          <span className="text-xs text-muted-foreground">
            第 {index + 1} / {STEPS.length} 步 · 下一步：{step.next}
          </span>
          {index < STEPS.length - 1 ? (
            <button
              type="button"
              onClick={() => setStepKey(STEPS[index + 1].key)}
              className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              下一步：{STEPS[index + 1].label}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              开始使用 🎉
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
