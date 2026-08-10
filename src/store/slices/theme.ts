import type { StateCreator } from "zustand";
import type { AppState, Language, ThemeCategory, ThemeMode } from "../types";

export interface ThemeSlice {
  lightTheme: ThemeMode;
  darkTheme: ThemeMode;
  themeCategory: ThemeCategory;
  language: Language;
  systemPrefersDark: boolean;
  setLightTheme: (theme: ThemeMode) => void;
  setDarkTheme: (theme: ThemeMode) => void;
  setThemeCategory: (category: ThemeCategory) => void;
  setLanguage: (lang: Language) => void;
  setSystemPrefersDark: (value: boolean) => void;
  activeTheme: () => ThemeMode;
}

export const createThemeSlice: StateCreator<AppState, [], [], ThemeSlice> = (set, get) => ({
  lightTheme: "light-glass",
  darkTheme: "dark-starry",
  themeCategory: "dark",
  language: "zh_CN",
  systemPrefersDark: false,
  setLightTheme: (theme) => set({ lightTheme: theme }),
  setDarkTheme: (theme) => set({ darkTheme: theme }),
  setThemeCategory: (category) => set({ themeCategory: category }),
  setLanguage: (language) => set({ language }),
  setSystemPrefersDark: (value) => set({ systemPrefersDark: value }),
  activeTheme: () => {
    const state = get();
    if (state.themeCategory === "system") {
      return state.systemPrefersDark ? state.darkTheme : state.lightTheme;
    }
    return state.themeCategory === "light" ? state.lightTheme : state.darkTheme;
  },
});
