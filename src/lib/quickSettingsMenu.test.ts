import { describe, expect, it } from "vitest";
import {
  getQuickSettingsSubmenuOnPopoverChange,
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
