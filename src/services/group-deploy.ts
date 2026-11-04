/** 群组部署状态（group_bot_admins.rights JSON 的 deploy 结构）解析 */

export interface GroupDeployState {
  can_invite_users?: boolean;
  invite_link?: string | null;
  invite_link_name?: string | null;
  deployed_at?: string | null;
  deploy_mode?: string | null;
  bot_username?: string | null;
  chat_title?: string | null;
}

export function parseGroupDeployState(rights: string): GroupDeployState | null {
  try {
    const parsed = JSON.parse(rights || "{}") as GroupDeployState;
    if (!parsed.deploy_mode) return null;
    return parsed;
  } catch {
    return null;
  }
}
