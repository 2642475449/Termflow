import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useAppStore } from "@/store";
import type { QuickSettingsSubmenu } from "@/lib/quickSettingsMenu";
import PrimarySidebarRail, { SettingsMenu } from "./PrimarySidebarRail";

vi.mock("@/components/bottomRunner/BottomRunnerStatus", () => ({ BottomRunnerRailButton: () => null }));

function renderMenu(activeSubmenu: QuickSettingsSubmenu = null) {
  return renderToStaticMarkup(createElement(SettingsMenu, {
    open: true,
    menuId: "quick-settings-test",
    activeSubmenu,
    onClose: vi.fn(),
    onCheckVersion: vi.fn(),
    onToggleSubmenu: vi.fn(),
    onClearSubmenu: vi.fn(),
    checkingForUpdate: false,
  }));
}

it("renders every quick settings action as a native menu button", () => {
  const markup = renderMenu();
  expect(markup).toContain('role="menu"');
  expect(markup.match(/<button[^>]*role="menuitem"/g)).toHaveLength(4);
  expect(markup).not.toMatch(/<div[^>]*role="menuitem"/);
  expect(markup).toContain('aria-haspopup="menu" aria-expanded="false" aria-controls="quick-settings-test-theme"');
  expect(markup).toContain('aria-haspopup="menu" aria-expanded="false" aria-controls="quick-settings-test-language"');
  expect(markup).toContain(i18n.t("common.settings"));
  expect(markup).toContain(i18n.t("settings.quickMenu.checkVersion"));
});

it.each(["theme", "language"] as const)("exposes the %s submenu and exactly one checked option", (submenu) => {
  const markup = renderMenu(submenu);
  expect(markup).toContain(`id="quick-settings-test-${submenu}" role="menu"`);
  expect(markup).toContain(`aria-expanded="true" aria-controls="quick-settings-test-${submenu}"`);
  const options = markup.match(/<button[^>]*role="menuitemradio"[^>]*>[\s\S]*?<\/button>/g) ?? [];
  expect(options).toHaveLength(3);
  const checked = options.filter((option) => option.includes('aria-checked="true"'));
  expect(checked).toHaveLength(1);
  const initialState = useAppStore.getInitialState();
  expect(checked[0]).toContain(i18n.t(submenu === "theme"
    ? `settings.general.appearance.${initialState.themeCategory}`
    : `settings.languageName.${initialState.language}`));
});

it("connects the settings trigger to its menu and announces its collapsed state", () => {
  const markup = renderToStaticMarkup(createElement(PrimarySidebarRail));
  expect(markup).toMatch(/<button[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"[^>]*aria-controls="[^"]+"/);
});
