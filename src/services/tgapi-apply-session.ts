/**
 * TGAPI申请 管理端多步骤申请向导的服务端会话存储（v2.1.8）。
 *
 * my.telegram.org 的申请流程是四步串行调用（send_password → login → /apps → /apps/create），
 * 每步之间需要保住 random_hash 与登录成功后的 stel_token Cookie。
 * 机器人链路用 grammY session 保存；管理端弹窗是 HTTP 多步表单，
 * 这里用进程内 Map + TTL 保存（仅管理员向导使用，15 分钟过期）。
 */

/** 申请会话有效期（毫秒）：验证码与 stel_token 都是短时效凭证 */
const APPLY_SESSION_TTL_MS = 15 * 60 * 1000;

/** 清理间隔：每次读写时惰性清理过期会话即可，无需定时器 */
const MAX_SESSIONS = 64;

/** 服务端保存的申请会话（不回传给前端，前端只持有 sessionId） */
export interface TgApiApplySession {
  /** 申请手机号（国际格式） */
  phone: string;
  /** send_password 返回的 random_hash */
  randomHash: string;
  /** 登录成功后的 stel_token Cookie（verify 成功后写入） */
  stelToken: string | null;
  /** /apps 页面解析出的创建表单 hash（verify 确认无 APP 时写入，create 步骤复用） */
  appHash: string | null;
  /** TGAPI代理模式: 透传代理返回的 cookies（直连模式为 null） */
  proxyCookies: Record<string, string> | null;
  /** 过期时间戳 */
  expiresAt: number;
}

/** 进程内会话表（dev 热重载会重置，重新走一遍向导即可） */
const sessions = new Map<string, TgApiApplySession>();

/** 生成随机会话 id（crypto.randomUUID，Node 18+ 可用） */
function newSessionId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** 惰性清理过期会话（读写前调用，防止长期驻留内存） */
function purgeExpired(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) {
      sessions.delete(id);
    }
  }
}

/** 创建申请会话：记录手机号 + random_hash，返回 sessionId */
export function createTgApiApplySession(phone: string, randomHash: string, proxyCookies: Record<string, string> | null = null): string {
  purgeExpired();
  while (sessions.size >= MAX_SESSIONS) {
    // 超上限：淘汰最早过期的会话（Map 保持插入序，首个即最旧）
    const oldest = sessions.keys().next();
    if (oldest.done) break;
    sessions.delete(oldest.value);
  }
  const id = newSessionId();
  sessions.set(id, {
    phone,
    randomHash,
    stelToken: null,
    appHash: null,
    proxyCookies,
    expiresAt: Date.now() + APPLY_SESSION_TTL_MS,
  });
  return id;
}

/** 读取会话（不续期）；不存在/已过期返回 null */
export function getTgApiApplySession(sessionId: string): TgApiApplySession | null {
  purgeExpired();
  const session = sessions.get(sessionId);
  if (!session || session.expiresAt <= Date.now()) {
    return null;
  }
  return session;
}

/** 更新会话（登录成功后写入 stel_token / appHash / proxyCookies；每次操作顺带续期） */
export function updateTgApiApplySession(
  sessionId: string,
  patch: Partial<Pick<TgApiApplySession, "stelToken" | "appHash" | "proxyCookies">>,
): TgApiApplySession | null {
  const session = getTgApiApplySession(sessionId);
  if (!session) return null;
  const next: TgApiApplySession = {
    ...session,
    ...patch,
    expiresAt: Date.now() + APPLY_SESSION_TTL_MS,
  };
  sessions.set(sessionId, next);
  return next;
}

/** 结束并丢弃会话（结果展示完成后 / 出错重开） */
export function removeTgApiApplySession(sessionId: string): void {
  sessions.delete(sessionId);
}
