"use client";

import { useState } from "react";
import { FormDialog } from "@/components/admin/form-dialog";
import { inputClass, labelClass } from "@/components/admin/form-styles";
import { MenuParentSelect, type MenuTreeOption } from "@/components/admin/menu-parent-select";
import { PermissionTabs } from "@/components/admin/permission-tabs";
import { MENU_PERMISSION_VIEW } from "@/lib/menu-permissions";
import { saveMenuAction } from "./actions";

/** 菜单表单所需的字段快照（服务端组件整理后传入） */
export interface MenuFormValues {
  id: string;
  parentId: string;
  title: string;
  path: string;
  icon: string;
  sortOrder: number;
  visible: boolean;
  permissionCode: string | null;
  status: boolean;
}

export function MenuFormDialog({
  menu,
  menuOptions,
  defaultParentId,
  trigger,
  triggerClassName,
}: {
  menu?: MenuFormValues;
  menuOptions: MenuTreeOption[];
  defaultParentId?: string;
  trigger: React.ReactNode;
  triggerClassName?: string;
}) {
  const formKey = `menu-${menu?.id ?? "new"}-${defaultParentId ?? "root"}`;
  const initialParentId = menu
    ? menu.parentId
    : (defaultParentId ?? "0");
  const [parentId, setParentId] = useState(initialParentId);
  const [formKeyNonce, setFormKeyNonce] = useState(0);

  return (
    <FormDialog
      key={`${formKey}-${formKeyNonce}`}
      trigger={trigger}
      triggerClassName={triggerClassName}
      title={menu ? `编辑菜单 · ${menu.title}` : defaultParentId ? "新增下级菜单" : "新增菜单"}
      description="上级菜单支持在树状浮层中单选任意层级；目录菜单（有下级）可留空路径，页面菜单必须以 / 开头。"
      action={async (formData: FormData) => {
        await saveMenuAction(formData);
        setFormKeyNonce((nonce) => nonce + 1);
        setParentId(initialParentId);
      }}
      submitLabel="保存菜单"
    >
      <input type="hidden" name="id" value={menu?.id ?? ""} />
      <input type="hidden" name="parent_id" value={parentId} />
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1">
          <label className={labelClass}>上级菜单（点击展开树状浮层）</label>
          <MenuParentSelect
            menus={menuOptions}
            value={parentId}
            onChange={setParentId}
            excludedId={menu?.id}
          />
        </div>
        <div className="space-y-1">
          <label className={labelClass} htmlFor={`title-${menu?.id ?? "new"}`}>
            标题 *
          </label>
          <input
            id={`title-${menu?.id ?? "new"}`}
            name="title"
            required
            defaultValue={menu?.title ?? ""}
            placeholder="例如：数据中心"
            className={inputClass}
          />
        </div>
        <div className="space-y-1 md:col-span-2">
          <label className={labelClass} htmlFor={`path-${menu?.id ?? "new"}`}>
            路径
          </label>
          <input
            id={`path-${menu?.id ?? "new"}`}
            name="path"
            defaultValue={menu?.path ?? ""}
            placeholder="/admin/example（目录菜单可留空）"
            className={`font-mono ${inputClass}`}
          />
        </div>
        <div className="space-y-1">
          <label className={labelClass} htmlFor={`icon-${menu?.id ?? "new"}`}>
            图标（Emoji）
          </label>
          <input
            id={`icon-${menu?.id ?? "new"}`}
            name="icon"
            defaultValue={menu?.icon ?? ""}
            placeholder="📄"
            className={inputClass}
          />
        </div>
        <div className="space-y-1">
          <label className={labelClass} htmlFor={`sort-${menu?.id ?? "new"}`}>
            排序（越小越靠前）
          </label>
          <input
            id={`sort-${menu?.id ?? "new"}`}
            name="sort_order"
            type="number"
            defaultValue={menu?.sortOrder ?? 0}
            className={inputClass}
          />
        </div>
        <PermissionTabs
          name="permission_code"
          defaultValue={menu?.permissionCode ?? MENU_PERMISSION_VIEW}
        />
        <div className="flex items-end gap-6 pb-1">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              name="visible"
              value="1"
              defaultChecked={menu ? menu.visible : true}
              className="h-4 w-4"
            />
            侧边栏可见
          </label>
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              name="status"
              value="1"
              defaultChecked={menu ? menu.status : true}
              className="h-4 w-4"
            />
            启用
          </label>
        </div>
      </div>
    </FormDialog>
  );
}
