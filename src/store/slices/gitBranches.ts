import { create } from "zustand";
import { gitListBranches } from "@/lib/api";
import type { GitBranchListItem } from "@/types";

export const EMPTY_GIT_BRANCHES = {
  branches: [] as GitBranchListItem[],
  loading: false,
  error: null as string | null,
};
const requests = new Map<string, number>();
interface BranchStore {
  entries: Record<string, typeof EMPTY_GIT_BRANCHES>;
  refresh: (path: string) => Promise<void>;
}
export const useGitBranchesStore = create<BranchStore>((set) => ({
  entries: {},
  refresh: async (path) => {
    const request = (requests.get(path) ?? 0) + 1;
    requests.set(path, request);
    set((s) => ({
      entries: {
        ...s.entries,
        [path]: { ...EMPTY_GIT_BRANCHES, loading: true },
      },
    }));
    try {
      const branches = await gitListBranches(path);
      if (requests.get(path) !== request) return;
      set((s) => ({
        entries: {
          ...s.entries,
          [path]: { branches, loading: false, error: null },
        },
      }));
    } catch (error) {
      if (requests.get(path) !== request) return;
      set((s) => ({
        entries: {
          ...s.entries,
          [path]: { ...EMPTY_GIT_BRANCHES, error: String(error) },
        },
      }));
    }
  },
}));
