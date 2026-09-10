import { useEffect } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { useAppStore } from "@/store";
import { projectPathKey } from "@/lib/openProjects";
import { touchRecentProjects, type ProjectInfo } from "@/store/utils/recentProjects";
import { mergeRecentProjectRecords, visibleRecentProjects, type RecentProjectRecord } from "@/store/utils/recentProjectSync";

const SNAPSHOT_EVENT = "termflow:recent-projects-snapshot";
const REQUEST_EVENT = "termflow:recent-projects-request";
const STORAGE_KEY = "termflow-recent-projects-v1";

export async function broadcastRecentProjectOpened(project: ProjectInfo) {
  const state = useAppStore.getState();
  state.setRecentProjects(touchRecentProjects(state.recentProjects, project));
}

export function useRecentProjectSync(enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let applying = false;
    let records: RecentProjectRecord[] = [];
    const read = (): RecentProjectRecord[] => {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]") as RecentProjectRecord[]; }
      catch { return []; }
    };
    const apply = (incoming: RecentProjectRecord[]) => {
      records = mergeRecentProjectRecords(records, incoming);
      applying = true;
      try {
        const projects = visibleRecentProjects(records);
        if (JSON.stringify(projects) !== JSON.stringify(useAppStore.getState().recentProjects)) {
          useAppStore.getState().setRecentProjects(projects);
        }
        const serialized = JSON.stringify(records);
        if (localStorage.getItem(STORAGE_KEY) !== serialized) localStorage.setItem(STORAGE_KEY, serialized);
      } finally { applying = false; }
    };
    const publish = () => void emit(SNAPSHOT_EVENT, records).catch(console.warn);
    const initial = useAppStore.getState().recentProjects.map((project) => ({
      project, revision: project.lastOpenedAt, removed: false,
    }));
    apply(mergeRecentProjectRecords(read(), initial));
    // 覆盖右键启动的窗口初始化、应用内打开，以及删除和失效路径清理。
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (applying || state.recentProjects === previous.recentProjects) return;
      const nextKeys = new Set(state.recentProjects.map((project) => projectPathKey(project.path)));
      const previousByKey = new Map(previous.recentProjects.map((project) => [projectPathKey(project.path), project]));
      const revision = Math.max(Date.now(), ...records.map((record) => record.revision + 1));
      const changes: RecentProjectRecord[] = state.recentProjects
        .filter((project) => JSON.stringify(project) !== JSON.stringify(previousByKey.get(projectPathKey(project.path))))
        .map((project) => ({ project, revision, removed: false }));
      for (const project of previous.recentProjects) {
        if (!nextKeys.has(projectPathKey(project.path))) changes.push({ project, revision, removed: true });
      }
      apply(mergeRecentProjectRecords(read(), changes));
      publish();
    });
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY && event.newValue) {
        try { apply(JSON.parse(event.newValue) as RecentProjectRecord[]); } catch { /* 忽略损坏的缓存 */ }
      }
    };
    window.addEventListener("storage", onStorage);
    const listeners = Promise.all([
      listen<RecentProjectRecord[]>(SNAPSHOT_EVENT, (event) => { if (!disposed) apply(event.payload); }),
      listen(REQUEST_EVENT, () => { if (!disposed) publish(); }),
    ]);
    void listeners.then(() => {
      if (disposed) return;
      // 先监听再交换完整快照，补回新窗口加载期间错过的事件。
      publish();
      void emit(REQUEST_EVENT).catch(console.warn);
    }).catch(console.warn);
    return () => {
      disposed = true;
      unsubscribe();
      window.removeEventListener("storage", onStorage);
      void listeners.then((unlisteners) => unlisteners.forEach((unlisten) => unlisten())).catch(console.warn);
    };
  }, [enabled]);
}
