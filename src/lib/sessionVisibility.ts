interface VisibilityTab {
  kind: string;
  resourceId: string;
}

interface VisibilityPane {
  activeTabId: string | null;
}

type VisibilityLayoutNode =
  | { type: "pane"; paneId: string }
  | {
      type: "split";
      first: VisibilityLayoutNode;
      second: VisibilityLayoutNode;
    };

interface WorkspaceVisibilitySnapshot {
  activeSessionId: string | null;
  layout: { root: VisibilityLayoutNode };
  panesById: Record<string, VisibilityPane>;
  tabsById: Record<string, VisibilityTab>;
}

function collectVisiblePaneIds(node: VisibilityLayoutNode, paneIds: string[]) {
  if (node.type === "pane") {
    paneIds.push(node.paneId);
    return;
  }
  collectVisiblePaneIds(node.first, paneIds);
  collectVisiblePaneIds(node.second, paneIds);
}

/** Returns true when a Session is the active tab of any Pane in the visible layout. */
export function isSessionVisibleInWorkspace(
  sessionId: string,
  snapshot: WorkspaceVisibilitySnapshot
): boolean {
  const visiblePaneIds: string[] = [];
  collectVisiblePaneIds(snapshot.layout.root, visiblePaneIds);

  for (const paneId of visiblePaneIds) {
    const activeTabId = snapshot.panesById[paneId]?.activeTabId;
    if (!activeTabId) continue;
    const tab = snapshot.tabsById[activeTabId];
    if (tab?.kind === "session" && tab.resourceId === sessionId) return true;
  }

  // Compatibility fallback while a restored workspace snapshot is still
  // normalizing and Pane/Tab entities are not available yet.
  return snapshot.activeSessionId === sessionId;
}
