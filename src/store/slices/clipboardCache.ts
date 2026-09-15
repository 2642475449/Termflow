import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  cleanupClipboardCache, getClipboardCacheStatus, syncClipboardSessions,
  type ClipboardCacheStatus,
} from "@/lib/api";
import { collectClipboardSessionIds, removedClipboardSessionIds } from "@/lib/clipboardSessions";
import { useAppStore } from "@/store";

interface ClipboardCacheState {
  status: ClipboardCacheStatus | null;
  loading: boolean;
  cleaning: boolean;
  error: string | null;
  syncError: string | null;
  pendingRemoved: Record<string, number>;
  setPendingRemoved: (ids: string[]) => void;
  setAcknowledged: (snapshot: Record<string, number>) => void;
  setStatus: (status: ClipboardCacheStatus) => void;
  setSyncError: (error: string | null) => void;
}

export const useClipboardCacheStore = create<ClipboardCacheState>()(persist((set, get) => ({
  status: null, loading: false, cleaning: false, error: null, syncError: null, pendingRemoved: {},
  setPendingRemoved: (ids) => set((state) => {
    const pendingRemoved = { ...state.pendingRemoved };
    for (const id of ids) pendingRemoved[id] = Math.max(Date.now(), (pendingRemoved[id] ?? 0) + 1);
    return { pendingRemoved };
  }),
  setAcknowledged: (snapshot) => {
    const pendingRemoved = { ...get().pendingRemoved };
    for (const [id, version] of Object.entries(snapshot)) {
      if (pendingRemoved[id] === version) delete pendingRemoved[id];
    }
    set({ pendingRemoved });
  },
  setStatus: (status) => set({ status, error: null }),
  setSyncError: (syncError) => set({ syncError }),
}), {
  name: "termflow-clipboard-cache",
  storage: createJSONStorage(() => typeof localStorage !== "undefined" ? localStorage : {
    getItem: () => null, setItem: () => {}, removeItem: () => {},
  }),
  // 删除同步失败或退出时保留待办；后端引用账本由 SQLite 持久化。
  partialize: (state) => ({ pendingRemoved: state.pendingRemoved }),
}));

let cacheRequest: Promise<void> | null = null;

export function refreshClipboardCache(clean = false): Promise<void> {
  if (cacheRequest) return cacheRequest;
  useClipboardCacheStore.setState({ loading: !clean, cleaning: clean, error: null });
  cacheRequest = (clean ? cleanupClipboardCache() : getClipboardCacheStatus())
    .then((status) => useClipboardCacheStore.getState().setStatus(status))
    .catch((error: unknown) => {
      useClipboardCacheStore.setState({ error: String(error) });
      throw error;
    })
    .finally(() => {
      useClipboardCacheStore.setState({ loading: false, cleaning: false });
      cacheRequest = null;
    });
  return cacheRequest;
}

export function startClipboardSessionSync(): () => void {
  let present = collectClipboardSessionIds(useAppStore.getState());
  let disposed = false;
  let syncing = false;
  let dirty = true;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const drain = async () => {
    if (disposed || syncing) return;
    syncing = true;
    try {
      while (!disposed && dirty) {
        dirty = false;
        const snapshot = { ...useClipboardCacheStore.getState().pendingRemoved };
        const removed = Object.keys(snapshot).filter((id) => !present.includes(id));
        await syncClipboardSessions(present, removed);
        useClipboardCacheStore.getState().setAcknowledged(snapshot);
        useClipboardCacheStore.getState().setSyncError(null);
      }
    } catch (error) {
      dirty = true;
      console.error("Screenshot session reference sync failed:", error);
      useClipboardCacheStore.getState().setSyncError(String(error));
      if (!disposed) retry = setTimeout(() => { void drain(); }, 30_000);
    } finally {
      syncing = false;
    }
  };
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (state.sessions === previous.sessions && state.projectSessions === previous.projectSessions
      && state.projectArchivedSessions === previous.projectArchivedSessions) return;
    const next = collectClipboardSessionIds(state);
    if (next.join("\0") === present.join("\0")) return;
    useClipboardCacheStore.getState().setPendingRemoved(removedClipboardSessionIds(present, next));
    present = next;
    dirty = true;
    // 在主 store 的本地持久化完成后同步删除，失败的操作保留在 outbox 中。
    queueMicrotask(() => { void drain(); });
  });
  void drain();
  return () => {
    disposed = true;
    unsubscribe();
    if (retry) clearTimeout(retry);
  };
}
