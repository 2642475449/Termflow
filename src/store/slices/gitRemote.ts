import { create } from "zustand";
import { gitRemoteState } from "@/lib/api";
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
}

const requests = new Map<string, number>();
export const useGitRemoteStore = create<RemoteStore>((set) => ({
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
