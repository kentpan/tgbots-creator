import { NextResponse } from "next/server";
import { isEdgeRuntime } from "@/lib/telegram/runtime-mode";
import { getAppSetting } from "@/database/operations";

/**
 * v2.0.12 node 环境实操兜底（服务端强制，前端转发只是第一道）：
 *
 * 一键部署 / 加群申请 / 提交验证码 / 解析加群链接等实操接口在满足以下全部条件时
 * 拒绝本地执行（403）：
 * 1. 当前运行时为 node（非 edge）；
 * 2. 系统设置已配置线上站点（app_settings.api.base_url，https 远程地址）；
 * 3. 请求 host 不是该线上站点本身（防止线上反代回环误判）。
 *
 * 背景：同一 Bot Token 双环境部署时，事件消费方是线上 webhook——本地直连执行
 * 部署/实操会把数据写进本地库而线上库无感知，造成「申请加群无反应」类不一致。
 * 未配置线上站点的纯本地安装（独立部署用户）不受影响，保持可用。
 */
export async function assertRemoteExecution(
  request: Request,
): Promise<NextResponse | null> {
  if (isEdgeRuntime()) {
    return null; // 线上 edge 环境本来就是消费方，直接放行
  }

  const remote = (await getAppSetting("api.base_url"))?.trim() ?? "";
  if (!remote || !/^https?:\/\//i.test(remote)) {
    return null; // 未配置线上站点 = 纯本地安装，允许本地直连
  }

  let remoteHost = "";
  try {
    remoteHost = new URL(remote).host;
  } catch {
    return null;
  }
  // 本地 loopback/内网地址不算合法远程站点，维持本地可用
  try {
    const remoteUrl = new URL(remote);
    const hostname = remoteUrl.hostname;
    const isLocalRemote =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]" ||
      hostname === "::1" ||
      /^10\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
    if (isLocalRemote) return null;
  } catch {
    return null;
  }

  const requestHost = new URL(request.url).host;
  if (requestHost === remoteHost) {
    return null; // 请求本来就打在线上站点（同站点部署/反代回环），放行
  }

  return NextResponse.json(
    {
      ok: false,
      code: "LOCAL_OPS_FORBIDDEN",
      error:
        `Node 环境已禁止本地直连执行该操作（部署/加群申请等实操必须由线上站点 ${remote} 执行，` +
        "避免本地库与线上事件消费方数据不一致）。请刷新页面使用线上站点操作。",
    },
    { status: 403 },
  );
}
