export type QuickSettingsSubmenu = "language" | "theme" | null;

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
