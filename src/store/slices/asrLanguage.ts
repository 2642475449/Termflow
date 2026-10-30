import { normalizeAsrLanguage } from "@/lib/asrLanguage";
import type { AsrLanguageSlice } from "../types";

export function createAsrLanguageSlice(
  set: (partial: Partial<AsrLanguageSlice>) => void,
): AsrLanguageSlice {
  return {
    asrLanguage: "auto",
    setAsrLanguage: (language) => set({ asrLanguage: normalizeAsrLanguage(language) }),
  };
}
