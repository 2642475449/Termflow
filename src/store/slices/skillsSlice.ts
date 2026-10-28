import { create } from "zustand";
import type { SkillCatalog } from "@/types";

interface SkillsState {
  projectPath: string | null;
  catalog: SkillCatalog | null;
  loading: boolean;
  error: boolean;
  setProject: (path: string | null) => void;
  setCatalog: (path: string | null, catalog: SkillCatalog) => void;
  setLoading: (path: string | null, loading: boolean, error?: boolean) => void;
}

// 技能目录是文件系统快照，不持久化到 localStorage 或 SQLite。
export const useSkillsStore = create<SkillsState>((set) => ({
  projectPath: null, catalog: null, loading: true, error: false,
  setProject: (projectPath) => set({ projectPath, catalog: null, loading: true, error: false }),
  setCatalog: (path, catalog) => set((state) => state.projectPath === path ? { catalog, error: false } : state),
  setLoading: (path, loading, error = false) => set((state) => state.projectPath === path ? { loading, error } : state),
}));
