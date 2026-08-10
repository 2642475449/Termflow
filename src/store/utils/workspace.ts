import type { Session } from "@/types";
import i18n from "@/i18n";
import type {
  PaneState,
  ProjectWorkspace,
  SplitDirection,
  SplitMode,
  TabDropPosition,
  TabEntity,
  WorkspaceLayout,
} from "../types";

const MAIN_PANE_ID = "main";
const SETTINGS_ID = "__settings__";

export const DEFAULT_LAYOUT: WorkspaceLayout = {
  root: { type: "pane", paneId: MAIN_PANE_ID },
};

export function createDefaultWorkspace(): ProjectWorkspace {
  return {
    tabsById: {},
    panesById: {
      [MAIN_PANE_ID]: {
        id: MAIN_PANE_ID,
        tabIds: [],
        activeTabId: null,
        history: [],
      },
    },
    layout: DEFAULT_LAYOUT,
    activePaneId: MAIN_PANE_ID,
    focusedTabId: null,
  };
}

export function cloneWorkspace(workspace: ProjectWorkspace): ProjectWorkspace {
  return {
    tabsById: { ...workspace.tabsById },
    panesById: Object.fromEntries(
      Object.entries(workspace.panesById).map(([paneId, pane]) => [
        paneId,
        {
          ...pane,
          tabIds: [...pane.tabIds],
          history: [...pane.history],
        },
      ])
    ),
    layout: workspace.layout,
    activePaneId: workspace.activePaneId,
    focusedTabId: workspace.focusedTabId,
  };
}

export function createSettingsTab(now = Date.now()): TabEntity {
  return {
    id: SETTINGS_ID,
    kind: "settings",
    resourceId: SETTINGS_ID,
    title: i18n.t("common.settings"),
    closable: true,
    pinned: false,
    dirty: false,
    preview: false,
    createdAt: now,
    lastActivatedAt: now,
  };
}

export function createSessionTab(session: Session, now = Date.now()): TabEntity {
  return {
    id: session.id,
    kind: "session",
    resourceId: session.id,
    title: session.name,
    closable: true,
    pinned: false,
    dirty: false,
    preview: false,
    createdAt: session.createdAt ?? now,
    lastActivatedAt: now,
  };
}

export function getActivePane(workspace: ProjectWorkspace, paneId?: string): PaneState {
  const resolvedPaneId = paneId ?? workspace.activePaneId ?? MAIN_PANE_ID;
  return workspace.panesById[resolvedPaneId] ?? workspace.panesById[MAIN_PANE_ID];
}

export function touchPaneHistory(pane: PaneState, tabId: string) {
  pane.history = [...pane.history.filter((id) => id !== tabId), tabId];
}

export function findFallbackActiveTabId(pane: PaneState): string | null {
  const historyCandidate = [...pane.history].reverse().find((tabId) => pane.tabIds.includes(tabId));
  if (historyCandidate) return historyCandidate;
  return pane.tabIds[pane.tabIds.length - 1] ?? null;
}

function pruneEmptyLayoutNode(
  node: ProjectWorkspace["layout"]["root"],
  nonEmptyPaneIds: Set<string>
): ProjectWorkspace["layout"]["root"] | null {
  if (node.type === "pane") {
    return nonEmptyPaneIds.has(node.paneId) ? node : null;
  }
  const first = pruneEmptyLayoutNode(node.first, nonEmptyPaneIds);
  const second = pruneEmptyLayoutNode(node.second, nonEmptyPaneIds);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

export function compactEmptyPanes(workspace: ProjectWorkspace) {
  const nonEmptyPaneIds = new Set(
    Object.values(workspace.panesById)
      .filter((pane) => pane.tabIds.length > 0)
      .map((pane) => pane.id)
  );

  if (nonEmptyPaneIds.size === 0) {
    workspace.panesById = createDefaultWorkspace().panesById;
    workspace.layout = DEFAULT_LAYOUT;
    workspace.activePaneId = MAIN_PANE_ID;
    workspace.focusedTabId = null;
    return workspace;
  }

  for (const paneId of Object.keys(workspace.panesById)) {
    if (!nonEmptyPaneIds.has(paneId)) delete workspace.panesById[paneId];
  }
  const fallbackPaneId = nonEmptyPaneIds.values().next().value as string;
  workspace.layout = {
    root: pruneEmptyLayoutNode(workspace.layout.root, nonEmptyPaneIds) ?? {
      type: "pane",
      paneId: fallbackPaneId,
    },
  };
  if (!workspace.activePaneId || !nonEmptyPaneIds.has(workspace.activePaneId)) {
    workspace.activePaneId = fallbackPaneId;
    workspace.focusedTabId = workspace.panesById[fallbackPaneId].activeTabId;
  }
  return workspace;
}

export function normalizeWorkspace(workspace: ProjectWorkspace, sessions: Session[]): ProjectWorkspace {
  const nextWorkspace = cloneWorkspace(workspace);
  const sessionById = new Map(sessions.map((session) => [session.id, session]));

  if (!nextWorkspace.panesById[MAIN_PANE_ID]) {
    nextWorkspace.panesById[MAIN_PANE_ID] = {
      id: MAIN_PANE_ID,
      tabIds: [],
      activeTabId: null,
      history: [],
    };
  }

  for (const tab of Object.values(nextWorkspace.tabsById)) {
    if (tab.kind === "session") {
      const session = sessionById.get(tab.resourceId);
      if (!session) continue;
      tab.title = session.name;
    }
  }

  for (const pane of Object.values(nextWorkspace.panesById)) {
    pane.tabIds = pane.tabIds.filter((tabId) => {
      if (tabId === SETTINGS_ID) {
        if (!nextWorkspace.tabsById[tabId]) {
          nextWorkspace.tabsById[tabId] = createSettingsTab();
        }
        return true;
      }
      const session = sessionById.get(tabId);
      if (!session) return false;
      nextWorkspace.tabsById[tabId] =
        nextWorkspace.tabsById[tabId] ?? createSessionTab(session);
      nextWorkspace.tabsById[tabId].title = session.name;
      return true;
    });
    pane.history = pane.history.filter((tabId) => pane.tabIds.includes(tabId));
    if (pane.activeTabId && !pane.tabIds.includes(pane.activeTabId)) {
      pane.activeTabId = findFallbackActiveTabId(pane);
    }
  }

  const referencedTabIds = new Set(
    Object.values(nextWorkspace.panesById).flatMap((pane) => pane.tabIds)
  );
  for (const tabId of Object.keys(nextWorkspace.tabsById)) {
    if (!referencedTabIds.has(tabId)) {
      delete nextWorkspace.tabsById[tabId];
    }
  }

  compactEmptyPanes(nextWorkspace);

  if (!nextWorkspace.activePaneId || !nextWorkspace.panesById[nextWorkspace.activePaneId]) {
    nextWorkspace.activePaneId = MAIN_PANE_ID;
  }

  if (
    nextWorkspace.focusedTabId &&
    !nextWorkspace.tabsById[nextWorkspace.focusedTabId]
  ) {
    nextWorkspace.focusedTabId = getActivePane(nextWorkspace).activeTabId;
  }

  return nextWorkspace;
}

export function syncWorkspaceSnapshot(workspace: ProjectWorkspace) {
  const activePane = getActivePane(workspace);
  return {
    tabsById: workspace.tabsById,
    panesById: workspace.panesById,
    layout: workspace.layout,
    activePaneId: workspace.activePaneId,
    focusedTabId: workspace.focusedTabId,
    openTabs: [...activePane.tabIds],
    activeSessionId: activePane.activeTabId,
  };
}

export function ensureTabForId(
  workspace: ProjectWorkspace,
  tabId: string,
  sessions: Session[]
): TabEntity | null {
  if (workspace.tabsById[tabId]) return workspace.tabsById[tabId];
  if (tabId === SETTINGS_ID) {
    const tab = createSettingsTab();
    workspace.tabsById[tab.id] = tab;
    return tab;
  }
  const session = sessions.find((item) => item.id === tabId);
  if (!session) return null;
  const tab = createSessionTab(session);
  workspace.tabsById[tab.id] = tab;
  return tab;
}

export function openTabInWorkspace(
  workspace: ProjectWorkspace,
  tabId: string,
  sessions: Session[],
  paneId?: string
) {
  const nextWorkspace = cloneWorkspace(workspace);
  const pane = getActivePane(nextWorkspace, paneId);
  const tab = ensureTabForId(nextWorkspace, tabId, sessions);
  if (!tab) return nextWorkspace;
  if (!pane.tabIds.includes(tabId)) {
    pane.tabIds.push(tabId);
  }
  const now = Date.now();
  nextWorkspace.tabsById[tabId] = {
    ...tab,
    lastActivatedAt: now,
  };
  pane.activeTabId = tabId;
  touchPaneHistory(pane, tabId);
  nextWorkspace.activePaneId = pane.id;
  nextWorkspace.focusedTabId = tabId;
  return nextWorkspace;
}

export function activateTabInWorkspace(
  workspace: ProjectWorkspace,
  tabId: string | null,
  paneId?: string
) {
  const nextWorkspace = cloneWorkspace(workspace);
  const pane = getActivePane(nextWorkspace, paneId);
  if (!tabId) {
    pane.activeTabId = null;
    nextWorkspace.focusedTabId = null;
    nextWorkspace.activePaneId = pane.id;
    return nextWorkspace;
  }
  if (!pane.tabIds.includes(tabId)) return nextWorkspace;
  pane.activeTabId = tabId;
  touchPaneHistory(pane, tabId);
  if (nextWorkspace.tabsById[tabId]) {
    nextWorkspace.tabsById[tabId] = {
      ...nextWorkspace.tabsById[tabId],
      lastActivatedAt: Date.now(),
    };
  }
  nextWorkspace.activePaneId = pane.id;
  nextWorkspace.focusedTabId = tabId;
  return nextWorkspace;
}

export function closeTabInWorkspace(workspace: ProjectWorkspace, tabId: string, paneId?: string) {
  const nextWorkspace = cloneWorkspace(workspace);
  for (const pane of Object.values(nextWorkspace.panesById)) {
    if (paneId && pane.id !== paneId) continue;
    if (!pane.tabIds.includes(tabId)) continue;
    pane.tabIds = pane.tabIds.filter((id) => id !== tabId);
    pane.history = pane.history.filter((id) => id !== tabId);
    if (pane.activeTabId === tabId) {
      pane.activeTabId = findFallbackActiveTabId(pane);
    }
  }
  const stillReferenced = Object.values(nextWorkspace.panesById)
    .some((pane) => pane.tabIds.includes(tabId));
  if (!stillReferenced) delete nextWorkspace.tabsById[tabId];
  if (nextWorkspace.focusedTabId === tabId) {
    nextWorkspace.focusedTabId = getActivePane(nextWorkspace).activeTabId;
  }
  compactEmptyPanes(nextWorkspace);
  return nextWorkspace;
}

export function reorderTabsInWorkspace(
  workspace: ProjectWorkspace,
  sourceTabId: string,
  targetTabId: string,
  position: TabDropPosition,
  paneId?: string
) {
  if (sourceTabId === targetTabId) return workspace;
  const nextWorkspace = cloneWorkspace(workspace);
  const pane = getActivePane(nextWorkspace, paneId);
  const sourceIndex = pane.tabIds.indexOf(sourceTabId);
  const targetIndex = pane.tabIds.indexOf(targetTabId);
  if (sourceIndex < 0 || targetIndex < 0) return workspace;

  const nextTabIds = [...pane.tabIds];
  nextTabIds.splice(sourceIndex, 1);
  let insertIndex = targetIndex;
  if (sourceIndex < targetIndex) {
    insertIndex -= 1;
  }
  if (position === "after") {
    insertIndex += 1;
  }
  nextTabIds.splice(Math.max(0, insertIndex), 0, sourceTabId);
  pane.tabIds = nextTabIds;
  return nextWorkspace;
}

export function moveTabToPaneInWorkspace(
  workspace: ProjectWorkspace,
  tabId: string,
  sourcePaneId: string,
  targetPaneId: string,
  targetTabId?: string | null,
  position: TabDropPosition = "after"
) {
  if (sourcePaneId === targetPaneId) return workspace;
  const sourcePane = workspace.panesById[sourcePaneId];
  const targetPane = workspace.panesById[targetPaneId];
  if (!sourcePane?.tabIds.includes(tabId) || !targetPane) return workspace;

  const nextWorkspace = cloneWorkspace(workspace);
  const nextSourcePane = nextWorkspace.panesById[sourcePaneId];
  const nextTargetPane = nextWorkspace.panesById[targetPaneId];

  nextSourcePane.tabIds = nextSourcePane.tabIds.filter((id) => id !== tabId);
  nextSourcePane.history = nextSourcePane.history.filter((id) => id !== tabId);
  if (nextSourcePane.activeTabId === tabId) {
    nextSourcePane.activeTabId = findFallbackActiveTabId(nextSourcePane);
  }

  // A copied split can already contain the same tab. In that case, moving merely
  // removes the source copy and focuses the existing target copy.
  if (!nextTargetPane.tabIds.includes(tabId)) {
    const nextTabIds = [...nextTargetPane.tabIds];
    const targetIndex = targetTabId ? nextTabIds.indexOf(targetTabId) : -1;
    const insertIndex = targetIndex < 0
      ? nextTabIds.length
      : targetIndex + (position === "after" ? 1 : 0);
    nextTabIds.splice(insertIndex, 0, tabId);
    nextTargetPane.tabIds = nextTabIds;
  }
  nextTargetPane.activeTabId = tabId;
  touchPaneHistory(nextTargetPane, tabId);
  nextWorkspace.activePaneId = targetPaneId;
  nextWorkspace.focusedTabId = tabId;
  compactEmptyPanes(nextWorkspace);
  return nextWorkspace;
}

function replacePaneWithSplit(
  node: ProjectWorkspace["layout"]["root"],
  targetPaneId: string,
  newPaneId: string,
  direction: SplitDirection
): ProjectWorkspace["layout"]["root"] {
  if (node.type === "pane") {
    if (node.paneId !== targetPaneId) return node;
    const currentPane = { type: "pane" as const, paneId: targetPaneId };
    const newPane = { type: "pane" as const, paneId: newPaneId };
    const newPaneFirst = direction === "left" || direction === "up";
    return {
      type: "split",
      direction: direction === "left" || direction === "right" ? "horizontal" : "vertical",
      ratio: 0.5,
      first: newPaneFirst ? newPane : currentPane,
      second: newPaneFirst ? currentPane : newPane,
    };
  }
  return {
    ...node,
    first: replacePaneWithSplit(node.first, targetPaneId, newPaneId, direction),
    second: replacePaneWithSplit(node.second, targetPaneId, newPaneId, direction),
  };
}

export function splitTabInWorkspace(
  workspace: ProjectWorkspace,
  tabId: string,
  direction: SplitDirection,
  paneId?: string,
  mode: SplitMode = "move",
  newPaneId = `pane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
) {
  const nextWorkspace = cloneWorkspace(workspace);
  const sourcePane = getActivePane(nextWorkspace, paneId);
  if (!sourcePane.tabIds.includes(tabId) || (mode === "move" && sourcePane.tabIds.length <= 1)) {
    return workspace;
  }

  if (mode === "move") {
    sourcePane.tabIds = sourcePane.tabIds.filter((id) => id !== tabId);
    sourcePane.history = sourcePane.history.filter((id) => id !== tabId);
    if (sourcePane.activeTabId === tabId) {
      sourcePane.activeTabId = findFallbackActiveTabId(sourcePane);
    }
  }
  nextWorkspace.panesById[newPaneId] = {
    id: newPaneId,
    tabIds: [tabId],
    activeTabId: tabId,
    history: [tabId],
  };
  nextWorkspace.layout = {
    root: replacePaneWithSplit(nextWorkspace.layout.root, sourcePane.id, newPaneId, direction),
  };
  nextWorkspace.activePaneId = newPaneId;
  nextWorkspace.focusedTabId = tabId;
  return nextWorkspace;
}
