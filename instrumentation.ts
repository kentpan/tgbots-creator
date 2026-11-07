export async function register(): Promise<() => Promise<void>> {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return async () => {};
  }

  // v1.1.5: Cloudflare Workers/Pages(OpenNext + nodejs_compat) 下 NEXT_RUNTIME
  // 恒为 "nodejs", 但 workerd 是无常驻进程的 serverless 环境 —— 与既有 Edge
  // 行为保持一致: 不启动 bot 运行时(长轮询)/清理循环/Node 出站代理补丁,
  // bot 通过 Webhook(/api/telegram/webhook/[botId]) 接收更新。
  // workerd 运行时 navigator.userAgent 固定为 "Cloudflare-Workers"。
  if (typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers") {
    return async () => {};
  }

  const { loadDotEnv } = await import("@/lib/dotenv");
  loadDotEnv();

  // Node 24 fetch（undici）Happy Eyeballs 默认每地址仅 250ms 连接尝试窗口，
  // 高延迟出站网络（实测 IPv4 握手 ~240ms 擦边必输、IPv6 ENETUNREACH）下所有
  // fetch 全部 ETIMEDOUT——外部验证接口因此「一直网络异常」（2026-11-03 实测，
  // 修复后同一路径 2/3 成功）。2000ms 是 Node 官方 API 的合法取值范围。
  // node:net 走 new Function 逃逸：本文件会被 Next 打进 Edge chunk 做静态分析，
  // 静态 import("node:net") 触发 "not supported in the Edge Runtime" 构建警告
  // （与 src/database/client.ts 的 node:sqlite 范式一致）。
  const loadNet = new Function("return import('node:net')") as () => Promise<
    typeof import("node:net")
  >;
  const net = await loadNet();
  net.setDefaultAutoSelectFamilyAttemptTimeout(2000);

  // Node 出站代理补丁：必须在任何 Bot 实例 / Telegram 请求之前装载
  const { installTelegramProxyFetch } = await import("@/lib/telegram/transport");
  installTelegramProxyFetch();

  const { startBotRuntime, stopBotRuntime } = await import("@/bot/runtime");
  const { startMenuBots, stopAllMenuBots } = await import("@/bot/multi-runtime");

  try {
    await startBotRuntime();
  } catch (error) {
    console.error("Failed to start bot runtime:", error);
  }

  try {
    await startMenuBots();
  } catch (error) {
    console.error("Failed to start menu bots:", error);
  }

  // 镜像中继面自动拉起（MIRROR_* 凭据齐全才注册 inprocess relay；缺省静默跳过，
  // resolveRelay 会自动回退 remote 或受控降级）
  try {
    const { startMirrorRelayIfConfigured } = await import("@/relay/mirror-relay");
    await startMirrorRelayIfConfigured();
  } catch (error) {
    console.error("Failed to start mirror relay:", error);
  }

  return async () => {
    try {
      await stopBotRuntime();
    } catch (error) {
      console.error("Failed to stop bot runtime:", error);
    }
    try {
      await stopAllMenuBots();
    } catch (error) {
      console.error("Failed to stop menu bots:", error);
    }
  };
}
