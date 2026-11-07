/**
 * 镜像模块配置读取：v2.1.0 起密钥/地址保存在数据库 app_settings（管理后台「系统设置」
 * 可视化配置），环境变量作为存量部署的兼容回退。
 */

const MIRROR_RELAY_SECRET_KEY = "mirror.relay_secret";

let secretWarned = false;

/** 内部 API HMAC 密钥：DB（后台配置）优先 → 环境变量回退；都缺失时告警一次 */
export async function mirrorSecret(): Promise<string> {
  try {
    const { getCachedAppSettings } = await import("@/database/operations");
    const fromDb = (await getCachedAppSettings())[MIRROR_RELAY_SECRET_KEY]?.trim();
    if (fromDb) return fromDb;
  } catch (error) {
    console.error("[mirror] 读取数据库镜像密钥失败，回退环境变量:", error);
  }
  const value = (process.env.MIRROR_RELAY_SECRET ?? "").trim();
  if (!value && !secretWarned) {
    secretWarned = true;
    console.warn(
      "[mirror] 镜像密钥未配置（后台「系统设置」或 MIRROR_RELAY_SECRET）：remote 中继 HMAC 鉴权将使用空密钥，公网部署前必须显式配置",
    );
  }
  return value;
}

export interface MirrorEnvCredentials {
  apiId: number;
  apiHash: string;
  sessionString: string;
}

/** userbot 凭据是否齐全（齐全时 Node 平面允许拉起 inprocess relay） */
export function readMirrorCredentials(): MirrorEnvCredentials | null {
  const apiId = Number((process.env.MIRROR_API_ID ?? "").trim());
  const apiHash = (process.env.MIRROR_API_HASH ?? "").trim();
  const sessionString = (process.env.MIRROR_SESSION_STRING ?? "").trim();
  if (!apiId || !apiHash || !sessionString) return null;
  return { apiId, apiHash, sessionString };
}

/** 中继面下行直发所需的壳 bot token（仅中继面进程使用，不入库） */
export function readProxyBotToken(): string {
  return (process.env.MIRROR_PROXY_BOT_TOKEN ?? "").trim();
}
