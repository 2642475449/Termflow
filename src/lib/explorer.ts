import type { FileTreeEntryKind } from "@/types";
import { useAppStore } from "@/store";

export interface ExplorerRevealPathDetail {
  path: string;
  kind?: FileTreeEntryKind;
}

export const EXPLORER_REVEAL_PATH_EVENT = "explorer:reveal-path";
export const EXPLORER_SELECT_ALL_EVENT = "explorer:select-all";
let pendingRevealPath: ExplorerRevealPathDetail | null = null;

export function takePendingExplorerRevealPath(): ExplorerRevealPathDetail | null {
  const detail = pendingRevealPath;
  pendingRevealPath = null;
  return detail;
}

export function revealExplorerPath(path: string, kind?: FileTreeEntryKind) {
  const detail = { path, kind };
  pendingRevealPath = detail;
  const state = useAppStore.getState();
  state.setActiveSidebarSection("project");
  state.setSidebarCollapsed(false);

  window.setTimeout(() => {
    // Keep the request pending until the explorer confirms receipt. The panel
    // may not be mounted yet when the sidebar section changes in the same turn.
    if (pendingRevealPath !== detail) return;
    window.dispatchEvent(
      new CustomEvent<ExplorerRevealPathDetail>(EXPLORER_REVEAL_PATH_EVENT, {
        detail,
      })
    );
  }, 0);
}

export function selectAllExplorerEntries() {
  window.dispatchEvent(new CustomEvent(EXPLORER_SELECT_ALL_EVENT));
}
