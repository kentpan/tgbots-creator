"use client";

import { useMemo, useState } from "react";
import { Check, ChevronDown, ChevronsUpDown, FolderTree } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export interface MenuTreeOption {
  id: string;
  parentId: string;
  title: string;
  icon: string | null;
  sortOrder: number;
}

interface FlatItem extends MenuTreeOption {
  depth: number;
  disabled: boolean;
}

/**
 * 树状菜单下拉浮层：单选任意层级的菜单作为上级菜单，
 * 「顶级菜单」为根选项；excludedId 及其后代被禁用（避免把自己挂到自己的子孙下形成循环）。
 * 排序规则与菜单列表页完全一致：sort_order 升序，同序按 id 升序。
 */
export function MenuParentSelect({
  menus,
  value,
  onChange,
  excludedId,
}: {
  menus: MenuTreeOption[];
  value: string;
  onChange: (next: string) => void;
  excludedId?: string;
}) {
  const [open, setOpen] = useState(false);

  const flat = useMemo<FlatItem[]>(() => {
    const childrenMap = new Map<string, MenuTreeOption[]>();
    for (const menu of menus) {
      const key = menu.parentId || "0";
      const bucket = childrenMap.get(key) ?? [];
      bucket.push(menu);
      childrenMap.set(key, bucket);
    }
    const sortNodes = (items: MenuTreeOption[]): MenuTreeOption[] =>
      [...items].sort((a, b) => a.sortOrder - b.sortOrder || Number(a.id) - Number(b.id));

    const result: FlatItem[] = [];
    const visit = (item: MenuTreeOption, depth: number, locked: boolean): void => {
      const selfLocked = locked || item.id === excludedId;
      result.push({ ...item, depth, disabled: selfLocked });
      for (const child of sortNodes(childrenMap.get(item.id) ?? [])) {
        visit(child, depth + 1, selfLocked);
      }
    };
    for (const root of sortNodes(childrenMap.get("0") ?? [])) {
      visit(root, 0, false);
    }
    return result;
  }, [menus, excludedId]);

  const currentRootLabel = value === "0" || value === "" ? "顶级菜单" : null;
  const currentItem = currentRootLabel ? null : flat.find((item) => item.id === value);
  const label = currentRootLabel
    ? "顶级菜单"
    : currentItem
      ? `${currentItem.icon ? `${currentItem.icon} ` : ""}${currentItem.title}`
      : `菜单 #${value}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none transition focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
        >
          <span className="flex min-w-0 items-center gap-1.5 truncate">
            <FolderTree className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{label}</span>
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] overflow-hidden p-1" align="start">
        <div className="max-h-64 overflow-y-auto overflow-x-hidden">
          <ParentOption
            depth={0}
            label="顶级菜单"
            icon={null}
            selected={value === "0" || value === ""}
            disabled={false}
            onSelect={() => {
              onChange("0");
              setOpen(false);
            }}
          />
          {flat.map((item) => (
            <ParentOption
              key={item.id}
              depth={item.depth}
              label={item.title}
              icon={item.icon}
              selected={value === item.id}
              disabled={item.disabled}
              onSelect={() => {
                onChange(item.id);
                setOpen(false);
              }}
            />
          ))}
        </div>
        {excludedId ? (
          <p className="border-t px-2 py-1.5 text-xs text-muted-foreground">
            自身及其下级菜单不可选择，避免循环层级。
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function ParentOption({
  depth,
  label,
  icon,
  selected,
  disabled,
  onSelect,
}: {
  depth: number;
  label: string;
  icon: string | null;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm ${
        disabled
          ? "cursor-not-allowed text-muted-foreground/50"
          : selected
            ? "bg-primary/10 font-medium"
            : "hover:bg-accent"
      }`}
      style={{ paddingLeft: `${8 + depth * 18}px` }}
    >
      {depth > 0 ? <ChevronDown className="h-3.5 w-3.5 -rotate-90 shrink-0 text-muted-foreground/50" /> : null}
      <span className="shrink-0">{icon ?? (depth === 0 ? "🏠" : "📄")}</span>
      <span className={`min-w-0 flex-1 truncate ${depth === 0 ? "font-medium" : ""}`}>{label}</span>
      {selected ? <Check className="h-4 w-4 shrink-0 text-primary" /> : null}
    </button>
  );
}
