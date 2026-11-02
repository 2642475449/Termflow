import { create } from "zustand";
import { detectProjectIcon } from "@/lib/api";
import { projectPathKey } from "@/lib/openProjects";

interface ProjectIconEntry {
  src: string | null;
  checkedAt: number;
}

interface ProjectIconsState {
  icons: Record<string, ProjectIconEntry>;
  loading: Record<string, boolean>;
  setProjectIcon: (path: string) => Promise<void>;
  setProjectIconFailed: (path: string, src: string) => void;
}

// 派生缓存不进入业务持久化；重启后重新读取，菜单再次打开时允许刷新。
export const useProjectIconsStore = create<ProjectIconsState>((set, get) => ({
  icons: {},
  loading: {},
  setProjectIcon: async (path) => {
    const key = projectPathKey(path);
    const state = get();
    if (state.loading[key] || (state.icons[key] && Date.now() - state.icons[key].checkedAt < 60_000)) return;
    set({ loading: { ...state.loading, [key]: true } });
    try {
      const src = await detectProjectIcon(path);
      set((current) => ({ icons: { ...current.icons, [key]: { src, checkedAt: Date.now() } } }));
    } catch {
      // IPC 暂不可用时保留原图，下次打开菜单可重试。
    } finally {
      set((current) => ({ loading: { ...current.loading, [key]: false } }));
    }
  },
  setProjectIconFailed: (path, src) => {
    const key = projectPathKey(path);
    if (get().icons[key]?.src !== src) return;
    set((state) => ({ icons: { ...state.icons, [key]: { src: null, checkedAt: Date.now() } } }));
  },
}));
