import { create } from "zustand";
import { gitFetch, gitRemoteState } from "@/lib/api";
import { useGitStatusStore } from "./gitStatus";
import { dispatchGitGraphRefresh } from "@/lib/gitGraphEvents";
import type { GitRemoteState } from "@/lib/gitRemoteAction";

interface RemoteStore {
  entries: Record<
    string,
    { data: GitRemoteState | null; error: string | null }
  >;
  busy: Record<string, string | null>;
  fetchErrors: Record<string, string | null>;
  setFetchError: (path: string, error: string | null) => void;
  setBusy: (path: string, action: string | null) => void;
  refresh: (path: string) => Promise<void>;
  fetching: Record<string, boolean>;
  fetchedAt: Record<string, number>;
  attemptedAt: Record<string, number>;
  fetchFailures: Record<string, number>;
  fetchUpdates: (path: string, force?: boolean, intervalMs?: number) => Promise<void>;
}

const requests = new Map<string, number>();
const pendingFetches = new Map<string, Promise<void>>();
export const useGitRemoteStore = create<RemoteStore>((set, get) => ({
  fetching: {},
  fetchedAt: {},
  attemptedAt: {},
  fetchFailures: {},
  fetchUpdates: (path, force = false, intervalMs = 5 * 60 * 1000) => {
    const pending = pendingFetches.get(path);
    if (pending) return pending;
    const retryDelay = Math.min(60 * 60 * 1000, intervalMs * 2 ** Math.min(get().fetchFailures[path] ?? 0, 4));
    const attemptedAt = get().attemptedAt[path];
    if (get().busy[path] || (!force && attemptedAt !== undefined && Date.now() - attemptedAt < retryDelay)) return Promise.resolve();
    set((s) => ({ fetching: { ...s.fetching, [path]: true }, attemptedAt: { ...s.attemptedAt, [path]: Date.now() } }));
    const task = Promise.resolve().then(async () => {
      try {
        const result = await gitFetch(path);
        if (!result.success) throw new Error(result.message);
        set((s) => ({ fetchedAt: { ...s.fetchedAt, [path]: Date.now() }, fetchFailures: { ...s.fetchFailures, [path]: 0 } }));
        get().setFetchError(path, null);
        await useGitStatusStore.getState().refresh(path);
        await get().refresh(path);
        dispatchGitGraphRefresh(path);
      } catch (error) {
        get().setFetchError(path, error instanceof Error ? error.message : String(error));
        set((s) => ({ fetchFailures: { ...s.fetchFailures, [path]: (s.fetchFailures[path] ?? 0) + 1 } }));
      }
      finally { pendingFetches.delete(path); set((s) => ({ fetching: { ...s.fetching, [path]: false } })); }
    });
    pendingFetches.set(path, task);
    return task;
  },
  entries: {},
  busy: {},
  fetchErrors: {},
  setFetchError: (path, error) =>
    set((s) => ({ fetchErrors: { ...s.fetchErrors, [path]: error } })),
  setBusy: (path, action) =>
    set((s) => ({ busy: { ...s.busy, [path]: action } })),
  refresh: async (path) => {
    const request = (requests.get(path) ?? 0) + 1;
    requests.set(path, request);
    try {
      const data = await gitRemoteState(path);
      if (requests.get(path) === request)
        set((s) => ({
          entries: { ...s.entries, [path]: { data, error: null } },
        }));
    } catch (error) {
      if (requests.get(path) === request)
        set((s) => ({
          entries: {
            ...s.entries,
            [path]: { data: null, error: String(error) },
          },
        }));
    }
  },
}));
