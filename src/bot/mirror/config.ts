/**
 * 镜像模块环境变量覆盖层（方案 §3.5）：
 * settings.ts 不支持 env 覆盖，镜像模块自建覆盖层读取 MIRROR_* 四个变量。
 */

let secretWarned = false;

/** 内部 API HMAC 密钥：中继面与用户面必须一致（缺省空值时告警一次） */
export function mirrorSecret(): string {
  const value = (process.env.MIRROR_RELAY_SECRET ?? "").trim();
  if (!value && !secretWarned) {
    secretWarned = true;
    console.warn(
      "[mirror] MIRROR_RELAY_SECRET 未配置：remote 中继 HMAC 鉴权将使用空密钥，公网部署前必须显式配置",
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
