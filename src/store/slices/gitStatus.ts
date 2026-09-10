import { create } from "zustand";
import { gitRepoInfo, gitStatus } from "@/lib/api";
import type { GitBranchInfo, GitFileStatus } from "@/types";
import type { GitStatusSnapshot } from "@/lib/gitStatusEvents";

export interface GitStatusEntry {
  isRepo: boolean | null;
  branchInfo: GitBranchInfo | null;
  fileStatuses: GitFileStatus[];
  loading: boolean;
  error: string | null;
}
export const EMPTY_GIT_STATUS: GitStatusEntry = {
  isRepo: null,
  branchInfo: null,
  fileStatuses: [],
  loading: false,
  error: null,
};
const requests = new Map<string, number>();
interface GitStatusStore {
  entries: Record<string, GitStatusEntry>;
  refresh: (path: string) => Promise<void>;
  setSnapshot: (snapshot: GitStatusSnapshot) => void;
}
export const useGitStatusStore = create<GitStatusStore>((set) => ({
  entries: {},
  refresh: async (path) => {
    const request = (requests.get(path) ?? 0) + 1;
    requests.set(path, request);
    set((s) => ({
      entries: {
        ...s.entries,
        [path]: { ...(s.entries[path] ?? EMPTY_GIT_STATUS), loading: true },
      },
    }));
    try {
      const info = await gitRepoInfo(path);
      const files = info.isRepo ? await gitStatus(path) : [];
      if (requests.get(path) !== request) return;
      set((s) => ({
        entries: {
          ...s.entries,
          [path]: {
            isRepo: info.isRepo,
            branchInfo: info.branchInfo,
            fileStatuses: files,
            loading: false,
            error: null,
          },
        },
      }));
    } catch (error) {
      if (requests.get(path) !== request) return;
      set((s) => ({
        entries: {
          ...s.entries,
          [path]: {
            ...(s.entries[path] ?? EMPTY_GIT_STATUS),
            loading: false,
            error: String(error),
          },
        },
      }));
    }
  },
  setSnapshot: (snapshot) => {
    const path = snapshot.projectPath;
    requests.set(path, (requests.get(path) ?? 0) + 1);
    set((s) => ({
      entries: {
        ...s.entries,
        [path]: {
          isRepo: snapshot.isRepo,
          branchInfo: snapshot.branch,
          fileStatuses: snapshot.statuses,
          loading: false,
          error: null,
        },
      },
    }));
  },
}));
