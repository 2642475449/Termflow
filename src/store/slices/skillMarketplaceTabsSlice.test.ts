import { afterEach, expect, it } from "vitest";
import { useAppStore } from "@/store";
import { SKILL_MARKETPLACE_TAB_ID } from "@/lib/skillMarketplaceTab";
import { openSkillMarketplaceTab } from "./skillMarketplaceTabsSlice";

afterEach(() => useAppStore.setState(useAppStore.getInitialState(), true));

it("keeps the marketplace open through project tab switches and restores it when returning to a project", () => {
  const store = useAppStore.getState();
  store.setCurrentProject({ path: "C:/first", name: "First" });
  openSkillMarketplaceTab();
  store.openTab("__settings__");
  store.setActiveSession(SKILL_MARKETPLACE_TAB_ID);
  expect(useAppStore.getState().panesById.main.activeTabId).toBe(SKILL_MARKETPLACE_TAB_ID);
  store.setCurrentProject({ path: "C:/second", name: "Second" });
  expect(useAppStore.getState().tabsById[SKILL_MARKETPLACE_TAB_ID]).toBeUndefined();
  store.setCurrentProject({ path: "C:/first", name: "First" });
  expect(useAppStore.getState().tabsById[SKILL_MARKETPLACE_TAB_ID]?.kind).toBe("skill-market");
  store.closeTab(SKILL_MARKETPLACE_TAB_ID);
  expect(useAppStore.getState().tabsById[SKILL_MARKETPLACE_TAB_ID]).toBeUndefined();
});

it("supports opening, switching, and closing the marketplace without a project", () => {
  const store = useAppStore.getState();
  store.openTab("__settings__");
  openSkillMarketplaceTab();
  openSkillMarketplaceTab();
  expect(useAppStore.getState().panesById.main.tabIds).toEqual(["__settings__", SKILL_MARKETPLACE_TAB_ID]);
  store.setActiveSession("__settings__", "main");
  expect(useAppStore.getState().panesById.main.activeTabId).toBe("__settings__");
  store.openTab(SKILL_MARKETPLACE_TAB_ID);
  expect(useAppStore.getState().panesById.main.activeTabId).toBe(SKILL_MARKETPLACE_TAB_ID);
  store.closeTab(SKILL_MARKETPLACE_TAB_ID);
  expect(useAppStore.getState().panesById.main.activeTabId).toBe("__settings__");
  store.closeTab("__settings__");
  expect(useAppStore.getState().windowMode).toBe("launcher");
});
