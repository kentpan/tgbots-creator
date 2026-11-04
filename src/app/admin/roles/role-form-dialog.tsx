"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FormDialog } from "@/components/admin/form-dialog";
import { inputClass, labelClass } from "@/components/admin/form-styles";
import { saveRoleAction } from "./actions";

export interface PermissionTreeMenu {
  id: string;
  title: string;
  path: string;
  permissionCode: string | null;
  children: PermissionTreeMenu[];
}

export interface PermissionOption {
  code: string;
  name: string;
  description: string | null;
}

interface RoleData {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isBuiltin: boolean;
  checkedCodes: string[];
}

function familyOf(code: string | null): string | null {
  if (!code) return null;
  const index = code.indexOf(":");
  return index > 0 ? code.slice(0, index) : null;
}

function collectMenuCodes(menu: PermissionTreeMenu, permissions: PermissionOption[]): string[] {
  const family = familyOf(menu.permissionCode);
  const own = family
    ? permissions.filter((permission) => permission.code.startsWith(`${family}:`)).map((permission) => permission.code)
    : [];
  const childCodes = menu.children.flatMap((child) => collectMenuCodes(child, permissions));
  return Array.from(new Set([...own, ...childCodes]));
}

function TreeNode({
  menu,
  permissions,
  checked,
  onToggle,
  depth,
}: {
  menu: PermissionTreeMenu;
  permissions: PermissionOption[];
  checked: Set<string>;
  onToggle: (codes: string[], next: boolean) => void;
  depth: number;
}) {
  const checkboxRef = useRef<HTMLInputElement>(null);
  const family = familyOf(menu.permissionCode);
  const ownCodes = family
    ? permissions.filter((permission) => permission.code.startsWith(`${family}:`))
    : [];
  const descendantCodes = useMemo(
    () => collectMenuCodes(menu, permissions),
    [menu, permissions],
  );
  const allChecked = descendantCodes.length > 0 && descendantCodes.every((code) => checked.has(code));
  const someChecked = descendantCodes.some((code) => checked.has(code));

  useEffect(() => {
    if (checkboxRef.current) {
      checkboxRef.current.indeterminate = !allChecked && someChecked;
    }
  }, [allChecked, someChecked]);

  return (
    <div className={depth > 0 ? "ml-6 border-l pl-4" : ""}>
      <div className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
        <input
          ref={checkboxRef}
          type="checkbox"
          checked={allChecked}
          onChange={(event) => onToggle(descendantCodes, event.target.checked)}
          className="h-4 w-4"
        />
        <span className="text-sm font-medium">{menu.title}</span>
        <span className="font-mono text-sm text-muted-foreground">{menu.path}</span>
        {menu.children.length > 0 ? (
          <span className="rounded-full bg-muted px-2 py-0.5 text-sm text-muted-foreground">
            {menu.children.length} 个子菜单
          </span>
        ) : null}
      </div>
      {ownCodes.length > 0 ? (
        <div className="ml-6 flex flex-wrap gap-2 py-1">
          {ownCodes.map((permission) => (
            <label
              key={permission.code}
              className="flex items-center gap-2 rounded-md border px-2 py-1 text-sm hover:bg-accent"
            >
              <input
                type="checkbox"
                name="permissions"
                value={permission.code}
                checked={checked.has(permission.code)}
                onChange={(event) => onToggle([permission.code], event.target.checked)}
                className="h-4 w-4"
              />
              <span>{permission.name}</span>
              <span className="font-mono text-muted-foreground">{permission.code}</span>
            </label>
          ))}
        </div>
      ) : null}
      {menu.children.map((child) => (
        <TreeNode
          key={child.id}
          menu={child}
          permissions={permissions}
          checked={checked}
          onToggle={onToggle}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

export function RoleFormDialog({
  role,
  tree,
  permissions,
  trigger,
  triggerClassName,
}: {
  role?: RoleData;
  tree: PermissionTreeMenu[];
  permissions: PermissionOption[];
  trigger: React.ReactNode;
  triggerClassName?: string;
}) {
  const [checked, setChecked] = useState<Set<string>>(new Set(role?.checkedCodes ?? []));

  const toggle = (codes: string[], next: boolean): void => {
    setChecked((prev) => {
      const draft = new Set(prev);
      for (const code of codes) {
        if (next) draft.add(code);
        else draft.delete(code);
      }
      return draft;
    });
  };

  const selectAll = (): void => {
    setChecked(new Set(permissions.map((permission) => permission.code)));
  };

  const clearAll = (): void => {
    setChecked(new Set());
  };

  return (
    <FormDialog
      trigger={trigger}
      triggerClassName={triggerClassName}
      title={role ? `编辑角色 · ${role.name}` : "新增角色"}
      description="权限控制直接对应树状后台菜单：勾选菜单即授予其下全部权限点，也可单独勾选细粒度权限。"
      action={saveRoleAction}
      submitLabel="保存角色"
    >
      <input type="hidden" name="id" value={role?.id ?? ""} />
      <div className="grid gap-4 md:grid-cols-3">
        <div className="space-y-1">
          <label className={labelClass} htmlFor={`code-${role?.id ?? "new"}`}>
            角色编码 *
          </label>
          <input
            id={`code-${role?.id ?? "new"}`}
            name="code"
            required
            readOnly={Boolean(role?.isBuiltin)}
            defaultValue={role?.code ?? ""}
            placeholder="例如 content_editor"
            className={`${inputClass} font-mono ${role?.isBuiltin ? "disabled:opacity-60" : ""}`}
          />
        </div>
        <div className="space-y-1">
          <label className={labelClass} htmlFor={`name-${role?.id ?? "new"}`}>
            角色名称 *
          </label>
          <input
            id={`name-${role?.id ?? "new"}`}
            name="name"
            required
            defaultValue={role?.name ?? ""}
            placeholder="例如：内容编辑"
            className={inputClass}
          />
        </div>
        <div className="space-y-1">
          <label className={labelClass} htmlFor={`desc-${role?.id ?? "new"}`}>
            描述
          </label>
          <input id={`desc-${role?.id ?? "new"}`} name="description" defaultValue={role?.description ?? ""} className={inputClass} />
        </div>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className={labelClass}>权限分配（树状菜单）</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={selectAll}
              className="rounded-md border px-2 py-1 text-sm hover:bg-accent"
            >
              全选
            </button>
            <button
              type="button"
              onClick={clearAll}
              className="rounded-md border px-2 py-1 text-sm hover:bg-accent"
            >
              清空
            </button>
          </div>
        </div>
        <div className="max-h-80 space-y-1 overflow-y-auto rounded-lg border p-3">
          {tree.map((menu) => (
            <TreeNode
              key={menu.id}
              menu={menu}
              permissions={permissions}
              checked={checked}
              onToggle={toggle}
              depth={0}
            />
          ))}
          <p className="pt-2 text-sm text-muted-foreground">
            已选 {checked.size} / {permissions.length} 个权限点
          </p>
        </div>
      </div>
    </FormDialog>
  );
}
