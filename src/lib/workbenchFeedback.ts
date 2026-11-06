import { create } from "zustand";

interface WorkbenchNotice {
  text: string;
  expiresAt: number;
}

export const useWorkbenchFeedback = create<{ notice: WorkbenchNotice | null }>(() => ({ notice: null }));

/** Quiet feedback for frequent actions whose result is not otherwise visible. */
export function showWorkbenchFeedback(text: string) {
  useWorkbenchFeedback.setState({ notice: { text, expiresAt: Date.now() + 3000 } });
}
