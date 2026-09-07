import { create } from "zustand";
import { listOpenProjectWindows } from "@/lib/api";
import type { WindowProjectContext } from "@/types";

interface OpenProjectsState {
  windows: WindowProjectContext[];
  loading: boolean;
  setOpenProjectWindows: () => Promise<void>;
}

export const useOpenProjectsStore = create<OpenProjectsState>((set, get) => ({
  windows: [],
  loading: false,
  setOpenProjectWindows: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      set({ windows: await listOpenProjectWindows() });
    } catch (error) {
      console.error("Failed to list open project windows:", error);
    } finally {
      set({ loading: false });
    }
  },
}));
