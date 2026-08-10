import type { StateCreator } from "zustand";
import type { AppState } from "../types";

export interface SecuritySlice {
  skipPermissions: boolean;
  setSkipPermissions: (skip: boolean) => void;
}

export const createSecuritySlice: StateCreator<AppState, [], [], SecuritySlice> = (set) => ({
  skipPermissions: false,
  setSkipPermissions: (skip) => set({ skipPermissions: skip }),
});
