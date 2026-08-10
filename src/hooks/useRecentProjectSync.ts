import { useEffect } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { useAppStore } from "@/store";
import {
  touchRecentProjects,
  type ProjectInfo,
  type RecentProjectEntry,
} from "@/store/utils/recentProjects";

const RECENT_PROJECT_OPENED_EVENT = "termflow:recent-project-opened";

function mergeRecentProject(entry: RecentProjectEntry) {
  const state = useAppStore.getState();
  state.setRecentProjects(
    touchRecentProjects(state.recentProjects, entry, entry.lastOpenedAt),
  );
}

export async function broadcastRecentProjectOpened(project: ProjectInfo) {
  const entry: RecentProjectEntry = {
    ...project,
    lastOpenedAt: Date.now(),
  };

  // Update the opener immediately; Tauri events keep every other live window
  // in sync without waiting for a reload from persisted storage.
  mergeRecentProject(entry);
  await emit(RECENT_PROJECT_OPENED_EVENT, entry).catch((error) => {
    console.warn("Failed to broadcast recent project update:", error);
  });
}

export function useRecentProjectSync(enabled = true) {
  useEffect(() => {
    if (!enabled) return;

    const unlistenPromise = listen<RecentProjectEntry>(
      RECENT_PROJECT_OPENED_EVENT,
      (event) => mergeRecentProject(event.payload),
    );

    return () => {
      void unlistenPromise.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, [enabled]);
}
