import { expect, it } from "vitest";
import { createDefaultWorkspace, normalizeWorkspace, splitTabInWorkspace } from "@/store/utils/workspace";
import { openSkillMarketplaceInWorkspace, SKILL_MARKETPLACE_TAB_ID } from "./skillMarketplaceTab";

it("opens a full marketplace tab without changing the input workspace", () => {
  const workspace = createDefaultWorkspace();
  const next = openSkillMarketplaceInWorkspace(workspace, "Market", 10);
  expect(workspace.panesById.main.tabIds).toEqual([]);
  expect(next.panesById.main.tabIds).toEqual([SKILL_MARKETPLACE_TAB_ID]);
  expect(next.tabsById[SKILL_MARKETPLACE_TAB_ID]).toMatchObject({ kind: "skill-market", preview: false, createdAt: 10 });
  expect(next.focusedTabId).toBe(SKILL_MARKETPLACE_TAB_ID);
});

it("reactivates an existing marketplace pane without duplicating its tab", () => {
  const workspace = openSkillMarketplaceInWorkspace(createDefaultWorkspace(), "Market", 10);
  workspace.panesById.other = { id: "other", tabIds: [], activeTabId: null, history: [] };
  workspace.activePaneId = "other";
  const next = openSkillMarketplaceInWorkspace(workspace, "Translated market", 20);
  expect(next.activePaneId).toBe("main");
  expect(next.panesById.other.tabIds).toEqual([]);
  expect(next.panesById.main.tabIds).toEqual([SKILL_MARKETPLACE_TAB_ID]);
  expect(next.panesById.main.history).toEqual([SKILL_MARKETPLACE_TAB_ID]);
  expect(next.tabsById[SKILL_MARKETPLACE_TAB_ID]).toMatchObject({ title: "Translated market", createdAt: 10, lastActivatedAt: 20 });
});

it("retains the marketplace when normalizing a split workspace", () => {
  const workspace = openSkillMarketplaceInWorkspace(createDefaultWorkspace(), "Market");
  const split = splitTabInWorkspace(workspace, SKILL_MARKETPLACE_TAB_ID, "right", "main", "copy");
  const next = normalizeWorkspace(split, []);
  expect(Object.values(next.panesById).filter((pane) => pane.tabIds.includes(SKILL_MARKETPLACE_TAB_ID))).toHaveLength(2);
});
