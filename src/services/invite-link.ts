/**
 * 群组规范邀请链接管道（v2.0.14）：
 *
 * 「一键部署」与「/start join_ 深链」统一从本模块获取邀请链接，保证一个群组
 * 只维护一条规范链接，彻底解决两类线上事故：
 *
 * 1. 「每次部署都生成新链接」—— 旧实现 deploy 每次无条件 createChatInviteLink，
 *    且 group_bot_admins.rights 是「机器人权限配置」与「部署状态」共用的整列覆盖
 *    写入（互相清掉对方字段），部署保存的 invite_link 经常被权限保存抹掉，
 *    下次部署找不到旧链接又生成新的 → 链接爆炸、买家手里的旧链接与系统不一致。
 *
 * 2. 「点击生成的链接提示已失效」—— Telegram 两种场景会让机器人生成的链接
 *    全部作废（与 expire_date 无关，本系统从不设置有效期）：
 *    - 机器人被移出群组（kicked/left）：其创建的全部邀请链接被 Telegram 自动作废；
 *    - 基础群升级为超级群（chat_id 迁移）：旧 chat_id 作废，旧链接随之失效。
 *    本模块复用前用 editChatInviteLink 做无实际变更探测：is_revoked=true 或
 *    Telegram 确定性死链报错（链接不存在/非本 bot 创建/群已迁移）→ 视为死链，
 *    自动新建并落库；超时/网络抖动等瞬时故障则宁可信其活（复用旧链接），
 *    绝不因网络抖动误判而乱建新链接。
 */

import type { Api } from "grammy";
import { GrammyError } from "grammy";
import { getGroupBotAdminByBotAndChat, upsertGroupBotAdmin } from "@/database/operations";
import { parseGroupDeployState } from "@/services/group-deploy";

/** 本系统生成的邀请链接统一名称（探测 edit 时回写，保持规范） */
export const DEPLOY_LINK_NAME = "TGuard 加群验证";

/**
 * 从 Telegram 400 错误中提取群升级迁移参数（migrate_to_chat_id）。
 *
 * 基础群升级超级群后，旧 chat_id 的一切调用都返回
 * 「400 Bad Request: group chat was upgraded to a supergroup chat」并携带
 * parameters.migrate_to_chat_id —— grammY 的 GrammyError 会把它暴露在
 * error.parameters 上（TelegramError 无该字段，用鸭子类型兼容读取）。
 * 非迁移错误返回 null。
 */
export function migratedChatIdFromError(error: unknown): bigint | null {
  if (!error || typeof error !== "object") return null;
  const parameters = (error as { parameters?: { migrate_to_chat_id?: unknown } }).parameters;
  const migrated = parameters?.migrate_to_chat_id;
  if (typeof migrated === "number" && Number.isFinite(migrated)) {
    return BigInt(Math.trunc(migrated));
  }
  return null;
}

/**
 * 合并 group_bot_admins.rights JSON：保留既有字段（「机器人权限配置」写入的
 * can_* 权限集合、「一键部署」写入的 invite_link/deploy 状态），仅覆盖 patch 键。
 *
 * v2.0.14 修复：rights 列旧实现是整列覆盖 —— 权限保存清掉部署状态、部署保存
 * 清掉权限集合，两边互踩；统一改走本函数合并写入。
 */
export function mergeGroupBotAdminRights(
  existingRaw: string | null | undefined,
  patch: Record<string, unknown>,
): string {
  let existing: Record<string, unknown> = {};
  if (existingRaw) {
    try {
      const parsed = JSON.parse(existingRaw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      /* 坏数据按空对象处理，patch 字段照常写入 */
    }
  }
  return JSON.stringify({ ...existing, ...patch });
}

export interface AcquireInviteLinkResult {
  /** 可直接发给买家的邀请链接（公开群=公开链接；复用或新建） */
  invite_link: string;
  /** true = 复用了已保存的链接（未新建） */
  reused: boolean;
  /** 部署状态中的 deployed_at（复用时返回原值，新建时返回当前时间） */
  deployed_at: string;
}

/** 链接形态：public=公开群自定义链接（t.me/<username>）；join_request=申请制邀请链接；direct=普通邀请链接 */
export type InviteLinkMode = "public" | "join_request" | "direct";

/**
 * 探测失败是否为「确定性死链」信号。
 *
 * 只有 Telegram 明确告知链接不存在/非本 bot 创建/群已迁移（含 migrate 参数）才
 * 算死链；超时、网络抖动、5xx、429 一律视为瞬时故障 —— 宁可信其活，复用旧链接，
 * 绝不因网络抖动误判而乱建新链接（否则代理抖动环境下每次部署都会新建，
 * 正是「每次部署都生成一条新链接」的帮凶）。
 */
export function isDefinitiveInviteLinkDeath(error: unknown): boolean {
  if (migratedChatIdFromError(error) !== null) return true;
  if (error instanceof GrammyError) {
    const text = (error.message || "").toLowerCase();
    // Telegram 确定性死链文案：invite link not found / invite hash invalid /
    // can't edit invite link that was not created by the bot 等
    return text.includes("invite link") || text.includes("invite_hash") || text.includes("hash invalid");
  }
  return false;
}

/**
 * 获取（必要时创建并合并落库）群组的规范邀请链接。
 *
 * 调用前提：机器人已是该群管理员且拥有「邀请用户 via 链接」权限（deploy 校验链
 * 已保证；/start join_ 深链场景由机器人真实在群内的事实兜底）。
 *
 * @param input.api         grammY API 实例（botByToken(...).api 或 ctx.api）
 * @param input.chatId      目标群 chat_id（调用方负责先解析 migrate_to_chat_id）
 * @param input.superGroup  是否超级群/频道（基础群不能创建申请制链接）
 * @param input.requireApproval 群组「新成员审核」开关；true=申请制链接，false=普通邀请链接
 * @param input.publicUsername v2.1.16：群组公开用户名（getChat.username，非空 = 公开群）——
 *   直接使用公开群自定义链接 https://t.me/<username>（群开启「加入审核」时点链接出
 *   「申请加入」→ chat_join_request 事件；绝不给公开群再生成 t.me/+hash 私密形态
 *   邀请链接 —— 那正是「部署后生成私密分享链接而不是公开自定义链接」的根因）
 * @param input.botId       提供时读取/合并落库部署状态；null 时仅新建、不落库
 * @param input.meta        新建落库时合并进 rights 的附加字段（bot_username / chat_title）
 */
export async function acquireStableGroupInviteLink(input: {
  api: Api;
  chatId: bigint;
  superGroup: boolean;
  requireApproval?: boolean;
  publicUsername?: string | null;
  botId?: bigint | null;
  meta?: Record<string, unknown>;
}): Promise<AcquireInviteLinkResult> {
  const { api, chatId, superGroup } = input;
  const botId = input.botId ?? null;
  const publicUsername = input.publicUsername?.trim() ?? "";
  const joinRequestMode = superGroup && (input.requireApproval ?? true);
  const deployedAt = new Date().toISOString();

  // 0) 公开群（v2.1.16）：自定义公开链接 t.me/<username>，无需机器人建链，
  //    不参与复用探测/重建（链接与机器人无关，永不失效）。
  //    群侧「加入审核」开关由群主在 Telegram 客户端控制（Bot API 无此开关），
  //    开启时点链接 → 「申请加入」→ chat_join_request → 机器人审批。
  if (publicUsername) {
    if (botId !== null) {
      const rights = mergeGroupBotAdminRights(
        (await getGroupBotAdminByBotAndChat(botId, chatId))?.rights ?? null,
        {
          can_invite_users: true,
          invite_link: `https://t.me/${publicUsername}`,
          invite_link_name: `公开群链接 @${publicUsername}`,
          deployed_at: deployedAt,
          deploy_mode: "public",
          ...(input.meta ?? {}),
        },
      );
      await upsertGroupBotAdmin({ botId, chatId, rights, status: "active" });
    }
    return {
      invite_link: `https://t.me/${publicUsername}`,
      reused: false,
      deployed_at: deployedAt,
    };
  }

  return acquireInviteLinkViaBot({
    api,
    chatId,
    joinRequestMode,
    ...(botId !== null ? { botId } : {}),
    ...(input.meta ? { meta: input.meta } : {}),
  });
}

/** 非公开群路径：申请制/普通邀请链接（复用探测 + 新建，v2.0.14 原逻辑） */
async function acquireInviteLinkViaBot(input: {
  api: Api;
  chatId: bigint;
  joinRequestMode: boolean;
  botId?: bigint | null;
  meta?: Record<string, unknown>;
}): Promise<AcquireInviteLinkResult> {
  const { api, chatId, joinRequestMode } = input;
  const botId = input.botId ?? null;

  // 部署状态行只读一次（复用探测与新建落库共用）
  const stateRow = botId !== null ? await getGroupBotAdminByBotAndChat(botId, chatId) : null;
  const storedLink = stateRow ? parseGroupDeployState(stateRow.rights)?.invite_link ?? null : null;

  // 1) 复用探测：editChatInviteLink 无实际变更 ＝ 存活探测。
  //    ⚠️ 实测（2026-11-08）：Telegram 的 editChatInviteLink 会把「未传的可选字段
  //    重置为默认」—— 只传 name 会把申请制链接静默改回普通链接
  //    （creates_join_request true→false，买家点链接直接进群绕过验证！），
  //    且响应 creates_join_request=false 又会让探测自判「形态不符」→ 误重建。
  //    因此必须显式回传 creates_join_request：探测同时兼做自愈
  //    （把被翻转/历史遗留的普通链接修回申请制形态）。
  //    - 响应 is_revoked=true → 已被撤销（机器人被移出群时 Telegram 自动作废其链接）→ 重建；
  //    - 编辑报错且为确定性死链（链接不存在/非本 bot 创建/群已迁移）→ 重建；
  //    - 编辑报错但为瞬时故障（超时/网络抖动）→ 宁可信其活，复用旧链接；
  //    - 响应 creates_join_request 仍与目标形态不符（理论上不可能，防御性兜底）→ 重建。
  if (storedLink) {
    try {
      const probe = await api.editChatInviteLink(Number(chatId), storedLink, {
        name: DEPLOY_LINK_NAME,
        ...(joinRequestMode ? { creates_join_request: true } : {}),
      });
      const joinRequestCompatible = joinRequestMode
        ? probe.creates_join_request === true
        : probe.creates_join_request !== true;
      if (probe.is_revoked !== true && joinRequestCompatible) {
        return {
          invite_link: probe.invite_link,
          reused: true,
          deployed_at:
            parseGroupDeployState(stateRow?.rights ?? "")?.deployed_at ?? new Date().toISOString(),
        };
      }
    } catch (error) {
      console.error(
        `[invite-link] reuse probe failed (chat=${chatId}, link=${storedLink}):`,
        error instanceof Error ? `${error.name}: ${error.message}` : error,
      );
      if (!isDefinitiveInviteLinkDeath(error)) {
        // 瞬时故障：复用旧链接（探测不到 ≠ 不存在）
        return {
          invite_link: storedLink,
          reused: true,
          deployed_at:
            parseGroupDeployState(stateRow?.rights ?? "")?.deployed_at ?? new Date().toISOString(),
        };
      }
      /* 确定性死链 → 走新建 */
    }
  }

  // 2) 新建（超级群按 requireApproval 选择申请制/普通链接；基础群始终普通链接）
  const invite = await api.createChatInviteLink(Number(chatId), {
    ...(joinRequestMode ? { creates_join_request: true } : {}),
    name: DEPLOY_LINK_NAME,
  });
  const deployedAt = new Date().toISOString();

  // 3) 合并写回部署状态（保留 can_* 权限等既有字段，绝不整列覆盖）
  if (botId !== null) {
    const rights = mergeGroupBotAdminRights(stateRow?.rights ?? null, {
      can_invite_users: true,
      invite_link: invite.invite_link,
      invite_link_name: invite.name ?? null,
      deployed_at: deployedAt,
      deploy_mode: joinRequestMode ? "join_request" : "direct",
      ...(input.meta ?? {}),
    });
    await upsertGroupBotAdmin({ botId, chatId, rights, status: "active" });
  }

  return { invite_link: invite.invite_link, reused: false, deployed_at: deployedAt };
}
