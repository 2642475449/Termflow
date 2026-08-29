import { create } from "zustand";

export type ApplicationUpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "error";

export type ApplicationUpdateErrorStage = "check" | "download" | "install";

export interface ApplicationUpdateSnapshot {
  phase: ApplicationUpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  releaseNotes: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
  error: string | null;
  errorStage: ApplicationUpdateErrorStage | null;
  modalOpen: boolean;
}

interface ApplicationUpdateState extends ApplicationUpdateSnapshot {
  patch: (snapshot: Partial<ApplicationUpdateSnapshot>) => void;
  openModal: () => void;
  closeModal: () => void;
  reset: (currentVersion: string) => void;
}

export function createInitialApplicationUpdateSnapshot(
  currentVersion: string,
): ApplicationUpdateSnapshot {
  return {
    phase: "idle",
    currentVersion,
    availableVersion: null,
    releaseNotes: null,
    downloadedBytes: 0,
    totalBytes: null,
    percent: null,
    error: null,
    errorStage: null,
    modalOpen: false,
  };
}

export const useApplicationUpdateStore = create<ApplicationUpdateState>((set) => ({
  ...createInitialApplicationUpdateSnapshot(""),
  patch: (snapshot) => set(snapshot),
  openModal: () => set({ modalOpen: true }),
  closeModal: () => set((state) => state.phase === "installing" ? state : { modalOpen: false }),
  reset: (currentVersion) => set(createInitialApplicationUpdateSnapshot(currentVersion)),
}));
