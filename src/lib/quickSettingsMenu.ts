export type QuickSettingsSubmenu = "language" | "theme" | null;

/** 菜单方向键循环移动焦点，Home/End 定位首尾；其他按键交给原生按钮。 */
export function getQuickSettingsMenuFocusIndex(
  key: string,
  currentIndex: number,
  itemCount: number,
): number | null {
  if (itemCount === 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return itemCount - 1;
  if (key === "ArrowDown") return (currentIndex + 1) % itemCount;
  if (key === "ArrowUp") return currentIndex <= 0 ? itemCount - 1 : currentIndex - 1;
  return null;
}

/**
 * 快速设置浮层关闭时必须收起二级菜单，避免隐藏内容保留上次的展开状态。
 */
export function getQuickSettingsSubmenuOnPopoverChange(
  open: boolean,
  activeSubmenu: QuickSettingsSubmenu
): QuickSettingsSubmenu {
  return open ? activeSubmenu : null;
}

export function toggleQuickSettingsSubmenu(
  activeSubmenu: QuickSettingsSubmenu,
  submenu: Exclude<QuickSettingsSubmenu, null>
): QuickSettingsSubmenu {
  return activeSubmenu === submenu ? null : submenu;
}
