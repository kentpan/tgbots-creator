"use client";

import { useState } from "react";
import { FormDialog } from "@/components/admin/form-dialog";
import { inputClass, labelClass, selectClass } from "@/components/admin/form-styles";
import { Switch } from "@/components/ui/switch";
import { saveMirrorBotAction } from "./actions";

export interface MirrorBotFormData {
  id: string;
  name: string;
  token: string;
  username: string | null;
  enabled: boolean;
  config: string;
}

export interface DeveloperAccountOption {
  id: string;
  apiId: string;
  phone: string;
  remark: string;
}

export interface BotOption {
  id: string;
  name: string;
  username: string | null;
}

function readMirror(config: string): {
  targetBot?: string;
  relayMode?: string;
  relayBaseUrl?: string;
  developerAccountId?: number;
  allowedUserIds?: number[];
  accessMode?: string;
  verifyBotId?: number;
  serializeMode?: string;
  actionTimeoutSeconds?: number;
  mediaInlineMaxMb?: number;
  rewriteRules?: Record<string, string>;
} {
  try {
    const parsed = JSON.parse(config) as { mirror?: Record<string, unknown> };
    return (parsed.mirror ?? {}) as Record<string, never>;
  } catch {
    return {};
  }
}

const RELAY_MODE_OPTIONS = [
  { value: "auto", label: "自动适配（推荐：按部署环境探测 + 故障自动切换）" },
  { value: "inprocess", label: "内置中继（Node 常驻进程内跑 userbot，零外部依赖）" },
  { value: "remote", label: "远程中继（连接独立 relay 服务的公网地址）" },
];

const ACCESS_MODE_OPTIONS = [
  { value: "open", label: "开放使用（所有人可用）" },
  { value: "verify_bot", label: "验证绑定（须先通过绑定的加群验证机器人验证）" },
  { value: "whitelist", label: "用户白名单（仅指定 Telegram 用户 ID 可用）" },
];

const SERIALIZE_OPTIONS = [
  { value: "global", label: "全局串行（目标 bot 只看到一个身份，最稳）" },
  { value: "per_user", label: "按用户串行（吞吐更高，需目标 bot 无多轮状态）" },
];

/**
 * 镜像机器人表单：保存后 config.mirror 段生效，
 * multi-runtime 三个启动路径都会自动分发到 createMirrorBot。
 */
export function MirrorFormDialog({
  bot,
  developerAccounts = [],
  bots = [],
  trigger,
  triggerClassName,
}: {
  bot?: MirrorBotFormData;
  developerAccounts?: DeveloperAccountOption[];
  bots?: BotOption[];
  trigger: React.ReactNode;
  triggerClassName?: string;
}) {
  const mirror = bot ? readMirror(bot.config) : {};
  const [enabled, setEnabled] = useState(bot ? bot.enabled : true);
  const [accessMode, setAccessMode] = useState(mirror.accessMode ?? "open");
  const idSuffix = bot?.id ?? "mirror-new";
  const rewriteText = Object.entries(mirror.rewriteRules ?? {})
    .map(([from, to]) => `${from}=${to}`)
    .join("\n");

  return (
    <FormDialog
      trigger={trigger}
      triggerClassName={triggerClassName}
      title={bot ? `编辑镜像机器人${bot.username ? `（@${bot.username}）` : ""}` : "新增镜像机器人"}
      description="壳 bot 镜像目标 bot 的交互能力：文本/命令/内联按钮/回调/媒体全部重建转发，目标 bot 用户名与来源痕迹不出现在用户面前。"
      action={saveMirrorBotAction}
      submitLabel="保存镜像机器人"
      contentClassName="sm:max-w-2xl"
    >
      <input type="hidden" name="id" value={bot?.id ?? ""} />
      <input type="hidden" name="enabled" value={enabled ? "1" : "0"} />

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1">
          <label className={labelClass} htmlFor={`mirror-name-${idSuffix}`}>
            备注名称 *
          </label>
          <input
            id={`mirror-name-${idSuffix}`}
            name="name"
            required
            defaultValue={bot?.name ?? ""}
            placeholder="镜像机器人"
            className={inputClass}
          />
        </div>
        <div className="space-y-1">
          <label className={labelClass} htmlFor={`mirror-enabled-${idSuffix}`}>
            状态
          </label>
          <label className="flex h-10 cursor-pointer items-center justify-between rounded-md border border-input bg-background px-3 shadow-sm">
            <span className="text-sm font-medium">{enabled ? "启用" : "停用"}</span>
            <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="镜像机器人状态" id={`mirror-enabled-${idSuffix}`} />
          </label>
        </div>
      </div>

      <div className="space-y-1">
        <label className={labelClass} htmlFor={`mirror-token-${idSuffix}`}>
          壳 bot Token（@BotFather 创建的新机器人）{bot ? "（留空保持不变）" : "*"}
        </label>
        <input
          id={`mirror-token-${idSuffix}`}
          name="token"
          defaultValue={bot?.token ?? ""}
          placeholder="123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
          className={`font-mono ${inputClass}`}
        />
        <p className="text-xs text-muted-foreground">用户只与这个壳 bot 对话；中继面持有此 Token 把目标 bot 的回复重建发出。</p>
      </div>

      <div className="space-y-1">
        <label className={labelClass} htmlFor={`mirror-target-${idSuffix}`}>
          目标 bot 用户名 *
        </label>
        <input
          id={`mirror-target-${idSuffix}`}
          name="target_bot"
          required
          defaultValue={mirror.targetBot ?? ""}
          placeholder="My_Telegram_RoBot"
          className={`font-mono ${inputClass}`}
        />
      </div>

      <div className="space-y-1">
        <label className={labelClass} htmlFor={`mirror-dev-account-${idSuffix}`}>
          开发者账号（API_ID / API_HASH）
        </label>
        <select
          id={`mirror-dev-account-${idSuffix}`}
          name="developer_account_id"
          defaultValue={mirror.developerAccountId ? String(mirror.developerAccountId) : ""}
          className={selectClass}
        >
          <option value="">跟随环境变量 MIRROR_API_ID / MIRROR_API_HASH</option>
          {developerAccounts.map((account) => (
            <option key={account.id} value={account.id}>
              #{account.id} · api_id {account.apiId}
              {account.phone ? ` · ${account.phone}` : ""}
              {account.remark ? ` · ${account.remark}` : ""}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          中继面 userbot 的 MTProto 凭据来源；列表在「开发者账号」页维护。Session 登录凭据始终走环境变量
          MIRROR_SESSION_STRING（等同账号完全控制权，不入库）。
        </p>
      </div>

      <div className="space-y-1">
        <label className={labelClass} htmlFor={`mirror-access-${idSuffix}`}>
          访问模式
        </label>
        <select
          id={`mirror-access-${idSuffix}`}
          name="access_mode"
          value={accessMode}
          onChange={(event) => setAccessMode(event.target.value)}
          className={selectClass}
        >
          {ACCESS_MODE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {accessMode === "verify_bot" ? (
        <div className="space-y-1">
          <label className={labelClass} htmlFor={`mirror-verify-bot-${idSuffix}`}>
            绑定加群验证机器人 *
          </label>
          <select
            id={`mirror-verify-bot-${idSuffix}`}
            name="verify_bot_id"
            defaultValue={mirror.verifyBotId ? String(mirror.verifyBotId) : ""}
            required
            className={selectClass}
          >
            <option value="">请选择机器人</option>
            {bots.map((option) => (
              <option key={option.id} value={option.id}>
                #{option.id} {option.name}
                {option.username ? `（@${option.username}）` : ""}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            用户在壳 bot 首次使用时会被引导到该机器人完成验证；验证通过记录全系统共用
            —— 加群时验过一次，镜像里直接放行，不会要求输入第二次验证码。
          </p>
        </div>
      ) : null}

      {accessMode === "whitelist" ? (
        <div className="space-y-1">
          <label className={labelClass} htmlFor={`mirror-allowed-${idSuffix}`}>
            用户白名单（逗号分隔 Telegram 用户 ID）
          </label>
          <input
            id={`mirror-allowed-${idSuffix}`}
            name="allowed_user_ids"
            defaultValue={(mirror.allowedUserIds ?? []).join(",")}
            placeholder="123456789, 987654321"
            className={`font-mono ${inputClass}`}
          />
        </div>
      ) : null}

      <div className="space-y-1">
        <label className={labelClass} htmlFor={`mirror-relay-mode-${idSuffix}`}>
          中继模式
        </label>
        <select
          id={`mirror-relay-mode-${idSuffix}`}
          name="relay_mode"
          defaultValue={mirror.relayMode ?? "auto"}
          className={selectClass}
        >
          {RELAY_MODE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1">
        <label className={labelClass} htmlFor={`mirror-relay-url-${idSuffix}`}>
          远程中继地址（relayBaseUrl，仅 remote / auto 回退时使用）
        </label>
        <input
          id={`mirror-relay-url-${idSuffix}`}
          name="relay_base_url"
          defaultValue={mirror.relayBaseUrl ?? ""}
          placeholder="https://relay.example.com"
          className={`font-mono ${inputClass}`}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="space-y-1">
          <label className={labelClass} htmlFor={`mirror-serialize-${idSuffix}`}>
            串行队列
          </label>
          <select
            id={`mirror-serialize-${idSuffix}`}
            name="serialize_mode"
            defaultValue={mirror.serializeMode ?? "global"}
            className={selectClass}
          >
            {SERIALIZE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label className={labelClass} htmlFor={`mirror-timeout-${idSuffix}`}>
            动作超时（秒）
          </label>
          <input
            id={`mirror-timeout-${idSuffix}`}
            name="action_timeout_seconds"
            type="number"
            min={5}
            max={300}
            defaultValue={String(mirror.actionTimeoutSeconds ?? 60)}
            className={inputClass}
          />
        </div>
        <div className="space-y-1">
          <label className={labelClass} htmlFor={`mirror-media-${idSuffix}`}>
            内联媒体上限（MB）
          </label>
          <input
            id={`mirror-media-${idSuffix}`}
            name="media_inline_max_mb"
            type="number"
            min={1}
            max={20}
            defaultValue={String(mirror.mediaInlineMaxMb ?? 20)}
            className={inputClass}
          />
        </div>
      </div>

      <div className="space-y-1">
        <label className={labelClass} htmlFor={`mirror-rewrite-${idSuffix}`}>
          痕迹清洗词表（每行一条：原词=替换词）
        </label>
        <textarea
          id={`mirror-rewrite-${idSuffix}`}
          name="rewrite_rules"
          rows={3}
          defaultValue={rewriteText}
          placeholder={"My Telegram RoBot=Mirror Bot"}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
        <p className="text-xs text-muted-foreground">
          @目标bot 提及与 t.me 深链会自动重写为壳 bot；此处补充品牌词等自定义替换规则。
        </p>
      </div>

      <div className="rounded-lg border border-dashed bg-muted/30 p-3 text-xs">
        <p className="font-medium text-foreground">中继模式怎么选？</p>
        <div className="mt-2 space-y-2 text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">背景：</span>
            Telegram 不允许 bot 之间互发消息，必须由一个真人账号（userbot）站在目标 bot
            面前收发消息，这个「userbot 跑在哪里」就是中继模式的选择。
          </p>
          <p>
            <span className="font-medium text-foreground">Cloudflare Pages（Edge）部署：</span>
            无法常驻运行 userbot，只能选「自动适配」或「远程中继」—— 把 relay
            服务（npx tsx scripts/mirror-relay.ts）跑在任意一台 Node 服务器/家宽机器上并公网可达，
            把地址填到「远程中继地址」，两侧环境变量配同一 MIRROR_RELAY_SECRET。
          </p>
          <p>
            <span className="font-medium text-foreground">Node 自托管部署：</span>
            选「自动适配」即可 —— 机器上配好 MIRROR_API_ID / MIRROR_API_HASH（或上方选择开发者账号）+
            MIRROR_SESSION_STRING + MIRROR_PROXY_BOT_TOKEN，进程启动时自动拉起内置中继，零外部依赖。
          </p>
          <p>
            <span className="font-medium text-foreground">自动适配</span> = Edge 环境自动用远程中继、Node
            环境自动用内置中继，坏了自动切换、恢复后自动切回；同一份构建零差异部署。
          </p>
        </div>
      </div>
    </FormDialog>
  );
}
