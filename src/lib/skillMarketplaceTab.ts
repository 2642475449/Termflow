import type { ProjectWorkspace } from "@/store/types";
import { cloneWorkspace, getActivePane, touchPaneHistory } from "@/store/utils/workspace";

export const SKILL_MARKETPLACE_TAB_ID = "__skill_marketplace__";

export function openSkillMarketplaceInWorkspace(workspace: ProjectWorkspace, title: string, now = Date.now()): ProjectWorkspace {
  const next = cloneWorkspace(workspace);
  const activePane = getActivePane(next);
  const pane = activePane.tabIds.includes(SKILL_MARKETPLACE_TAB_ID) ? activePane
    : Object.values(next.panesById).find((item) => item.tabIds.includes(SKILL_MARKETPLACE_TAB_ID)) ?? activePane;
  const tab = next.tabsById[SKILL_MARKETPLACE_TAB_ID] ?? {
    id: SKILL_MARKETPLACE_TAB_ID, kind: "skill-market", resourceId: SKILL_MARKETPLACE_TAB_ID,
    closable: true, pinned: false, dirty: false, preview: false, createdAt: now, title, lastActivatedAt: now,
  };
  next.tabsById[SKILL_MARKETPLACE_TAB_ID] = { ...tab, title, lastActivatedAt: now };
  if (!pane.tabIds.includes(SKILL_MARKETPLACE_TAB_ID)) pane.tabIds.push(SKILL_MARKETPLACE_TAB_ID);
  pane.activeTabId = SKILL_MARKETPLACE_TAB_ID;
  touchPaneHistory(pane, SKILL_MARKETPLACE_TAB_ID);
  next.activePaneId = pane.id;
  next.focusedTabId = SKILL_MARKETPLACE_TAB_ID;
  return next;
}
