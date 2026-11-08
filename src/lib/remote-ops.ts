"use client";

/**
 * v2.0.12 实操请求通道（机器人测试页 / 仿真屏专用）。
 *
 * v2.1.0 语义变更（用户拍板）：所有实操（一键部署 / 加群申请 / 提交验证码 /
 * 解析加群链接 / 群组验证配置 / 机器人权限 / 代理配置生成）一律**本地直接执行**，
 * 不再转发到线上站点执行 —— node 环境所有 api.telegram.org 出站调用统一收敛
 * 走配置的代理（传输层 telegramProxyFetch，代理面板可配），本地执行不会再因
 * 直连 Telegram 失败而不可用；数据一致性由部署形态保证（PROXY_MODE 代理透传
 * 模式下 node 服务器是唯一后端 + 事件消费方，本地库即线上库）。
 *
 * 因此本工具现在就是同源 fetch 的别名：保留函数与调用点签名不变，
 * 线上 edge 环境（原本就同源）行为完全不变。
 */

export async function opsFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, init);
}
