/** 菜单权限两档取值：读取（view）与编辑（manage）。服务端与客户端共享的纯常量模块。 */
export const MENU_PERMISSION_VIEW = "menus:view";
export const MENU_PERMISSION_MANAGE = "menus:manage";

export const MENU_PERMISSION_OPTIONS: { value: string; label: string; hint: string }[] = [
  { value: MENU_PERMISSION_VIEW, label: "读取", hint: "拥有菜单读取权限的角色可见" },
  { value: MENU_PERMISSION_MANAGE, label: "编辑", hint: "仅拥有菜单编辑权限的角色可见" },
];

/** 权限码 → 显示名（读取 / 编辑） */
export function permissionLabel(code: string | null): string {
  if (code === MENU_PERMISSION_MANAGE) return "编辑";
  if (code === MENU_PERMISSION_VIEW) return "读取";
  return "无限制";
}
