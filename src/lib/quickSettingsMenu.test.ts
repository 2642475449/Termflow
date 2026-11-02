import { describe, expect, it } from "vitest";
import {
  getQuickSettingsSubmenuOnPopoverChange,
  getQuickSettingsMenuFocusIndex,
  toggleQuickSettingsSubmenu,
} from "./quickSettingsMenu";

describe("quick settings menu", () => {
  it("clears the language submenu when the popover closes", () => {
    expect(getQuickSettingsSubmenuOnPopoverChange(false, "language")).toBe(null);
  });

  it("clears the theme submenu when the popover closes", () => {
    expect(getQuickSettingsSubmenuOnPopoverChange(false, "theme")).toBe(null);
  });

  it("does not activate a submenu when the popover opens", () => {
    expect(getQuickSettingsSubmenuOnPopoverChange(true, null)).toBe(null);
  });

  it("toggles the selected submenu and switches directly between submenus", () => {
    expect(toggleQuickSettingsSubmenu(null, "theme")).toBe("theme");
    expect(toggleQuickSettingsSubmenu("theme", "theme")).toBe(null);
    expect(toggleQuickSettingsSubmenu("language", "theme")).toBe("theme");
    expect(toggleQuickSettingsSubmenu("theme", "language")).toBe("language");
  });
});

it("moves menu focus with arrow keys and wraps at either end", () => {
  expect(getQuickSettingsMenuFocusIndex("ArrowDown", 0, 4)).toBe(1);
  expect(getQuickSettingsMenuFocusIndex("ArrowDown", 3, 4)).toBe(0);
  expect(getQuickSettingsMenuFocusIndex("ArrowUp", 2, 4)).toBe(1);
  expect(getQuickSettingsMenuFocusIndex("ArrowUp", 0, 4)).toBe(3);
});

it("moves to menu boundaries and leaves activation to native buttons", () => {
  expect(getQuickSettingsMenuFocusIndex("Home", 2, 4)).toBe(0);
  expect(getQuickSettingsMenuFocusIndex("End", 1, 4)).toBe(3);
  for (const key of ["Enter", " ", "Tab", "Escape", "ArrowRight", "ArrowLeft"]) {
    expect(getQuickSettingsMenuFocusIndex(key, 0, 4)).toBeNull();
  }
});

it("handles menus with no items, one item, or no current focus", () => {
  expect(getQuickSettingsMenuFocusIndex("ArrowDown", -1, 0)).toBeNull();
  expect(getQuickSettingsMenuFocusIndex("End", -1, 0)).toBeNull();
  expect(getQuickSettingsMenuFocusIndex("ArrowDown", 0, 1)).toBe(0);
  expect(getQuickSettingsMenuFocusIndex("ArrowUp", 0, 1)).toBe(0);
  expect(getQuickSettingsMenuFocusIndex("ArrowDown", -1, 4)).toBe(0);
  expect(getQuickSettingsMenuFocusIndex("ArrowUp", -1, 4)).toBe(3);
});
