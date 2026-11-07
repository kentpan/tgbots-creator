"use client";

import { useState } from "react";
import { saveMirrorSecretAction } from "@/app/admin/settings/actions";

/**
 * 镜像中继/远程同步密钥配置卡（按运行平面显示不同内容）：
 * - edge：MIRROR_RELAY_SECRET（中继回调回写、远程同步拉取、网关对接的 HMAC 共享密钥）
 * - node：SYNC_REMOTE_URL + SYNC_REMOTE_SECRET（把线上加群申请同步回本地库）
 * 生成按钮产生 64 hex 随机密钥；密钥已设置时再次生成需 confirm 确认（旧密钥立即失效）。
 */
export function MirrorSecretCard({
  mode,
  secretConfigured,
  secretMasked,
  initialUrl,
}: {
  mode: "edge" | "node";
  secretConfigured: boolean;
  secretMasked: string;
  initialUrl: string;
}) {
  const [secretValue, setSecretValue] = useState("");
  const [generating, setGenerating] = useState(false);

  const generate = (): void => {
    if (secretConfigured) {
      const ok = window.confirm(
        "密钥已设置。\n\n重新生成并保存后，旧密钥将立即失效：\n" +
          (mode === "edge"
            ? "中继网关 / 远程同步方需同步更新为相同的新密钥，否则其调用会被 401 拒绝。"
            : "线上镜像鉴权不受影响，但本地同步将无法通过线上校验，需把新密钥同步到线上后台。") +
          "\n\n确定重新生成？",
      );
      if (!ok) return;
    }
    setGenerating(true);
    try {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      let hex = "";
      for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
      setSecretValue(hex);
    } finally {
      setGenerating(false);
    }
  };

  const isEdge = mode === "edge";
  const secretLabel = isEdge ? "MIRROR_RELAY_SECRET" : "SYNC_REMOTE_SECRET";
  const secretName = isEdge ? "mirror_relay_secret" : "sync_remote_secret";

  return (
    <div className="rounded-xl border bg-card p-6">
      <h2 className="text-lg font-semibold">
        {isEdge ? "镜像中继密钥" : "远程同步（加群申请 → 本地库）"}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {isEdge
          ? "镜像中继回调回写、远程同步拉取、以及外部中继网关对接的 HMAC 共享密钥（保存在数据库，保存后即时生效，无需重启）。"
          : "本地让位线上 Webhook 消费后，清理循环每 5 分钟把线上加群申请增量同步回本地库。地址填线上部署地址（如 https://tgbots.ccwu.cc），密钥与线上「镜像中继密钥」保持一致。"}
      </p>
      <form action={saveMirrorSecretAction} className="mt-4 space-y-4">
        <input type="hidden" name="mode" value={mode} />
        {!isEdge ? (
          <div className="space-y-1">
            <label htmlFor="sync_remote_url" className="block text-sm font-medium">
              线上地址（SYNC_REMOTE_URL）
            </label>
            <input
              id="sync_remote_url"
              name="sync_remote_url"
              type="text"
              defaultValue={initialUrl}
              placeholder="https://tgbots.ccwu.cc"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-sm"
            />
          </div>
        ) : null}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label htmlFor={secretName} className="block text-sm font-medium">
              {secretLabel}
            </label>
            <button
              type="button"
              onClick={generate}
              disabled={generating}
              className="inline-flex h-7 items-center rounded-md border px-2.5 text-xs font-medium hover:bg-accent disabled:opacity-50"
            >
              ⟳ 生成新密钥
            </button>
          </div>
          <input
            id={secretName}
            name={secretName}
            type="password"
            value={secretValue}
            onChange={(event) => setSecretValue(event.target.value)}
            placeholder={
              secretConfigured
                ? `已设置（${secretMasked}）— 输入新值或点「生成」覆盖，留空保持不变`
                : "未设置 — 点「生成」或手动粘贴共享密钥"
            }
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-sm"
          />
          <p className="text-sm text-muted-foreground">
            {isEdge
              ? "外部中继网关（node-proxy-gateway）与远程同步方必须使用与此处完全相同的密钥。"
              : "须与线上部署后台「镜像中继密钥」完全相同，否则线上会以 401 拒绝本机拉取。"}
          </p>
        </div>
        <button
          type="submit"
          className="inline-flex h-10 items-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          保存
        </button>
      </form>
    </div>
  );
}
