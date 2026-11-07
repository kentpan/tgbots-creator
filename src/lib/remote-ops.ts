"use client";

/**
 * v2.0.12 实操请求转发工具（机器人测试页 / 仿真屏专用）：
 *
 * 本地 node 管理后台不再是事件消费方（线上 webhook 负责），因此「一键部署 /
 * 加群申请 / 提交验证码 / 解析加群链接 / 群组验证配置 / 机器人权限」等实操
 * 请求必须由线上站点（系统设置 api.base_url）执行，保证配置与申请数据落在
 * 事件消费方同一套库里。
 *
 * 行为：
 * - 页面首次调用时读取 /api/admin/runtime-info 并缓存；
 * - runtime=node 且 remote_base_url 已配置 → 请求发往线上站点（跨站携带线上
 *   登录 cookie，SameSite=None；自定义头 X-Admin-Client 强制预检防 CSRF）；
 * - runtime=edge（线上部署）或未配置线上站点 → 保持同源请求，行为不变；
 * - 跨站 401（线上未登录）时返回友好错误文案，引导先登录线上站点。
 */

interface RuntimeInfo {
  runtime: "node" | "edge";
  remoteBaseUrl: string | null;
}

let cachedInfo: RuntimeInfo | null = null;

async function loadRuntimeInfo(): Promise<RuntimeInfo> {
  if (cachedInfo) return cachedInfo;
  try {
    const response = await fetch("/api/admin/runtime-info", { cache: "no-store" });
    const payload = (await response.json()) as {
      ok?: boolean;
      runtime?: string;
      remote_base_url?: string | null;
    };
    cachedInfo = {
      runtime: payload.runtime === "edge" ? "edge" : "node",
      remoteBaseUrl:
        typeof payload.remote_base_url === "string" && payload.remote_base_url
          ? payload.remote_base_url
          : null,
    };
  } catch {
    cachedInfo = { runtime: "node", remoteBaseUrl: null };
  }
  return cachedInfo;
}

export async function opsFetch(path: string, init?: RequestInit): Promise<Response> {
  const info = await loadRuntimeInfo();
  const remote = info.remoteBaseUrl;

  if (info.runtime !== "node" || !remote || !/^https?:\/\//i.test(remote)) {
    return fetch(path, init);
  }

  const response = await fetch(remote.replace(/\/$/, "") + path, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.headers ?? {}),
      "X-Admin-Client": "web",
    },
  });

  if (response.status === 401) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: `线上站点未登录：请先打开 ${remote} 登录管理后台，再回到本页操作`,
      }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }
  return response;
}
