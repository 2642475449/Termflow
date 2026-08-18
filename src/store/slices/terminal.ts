import type { StateCreator } from "zustand";
import type { AppState } from "../types";
import {
  DEFAULT_TERMINAL_SCROLLBACK,
  normalizeTerminalScrollback,
} from "@/lib/terminalSettings";

export interface TerminalSlice {
  editorFontSize: number;
  terminalFontSize: number;
  terminalCursorBlink: boolean;
  terminalLineHeight: number;
  terminalScrollback: number;
  terminalRenderer: "webgl" | "standard";
  setEditorFontSize: (size: number) => void;
  setTerminalFontSize: (size: number) => void;
  setTerminalCursorBlink: (blink: boolean) => void;
  setTerminalLineHeight: (height: number) => void;
  setTerminalScrollback: (rows: number) => void;
  setTerminalRenderer: (renderer: "webgl" | "standard") => void;
}

export const createTerminalSlice: StateCreator<AppState, [], [], TerminalSlice> = (set) => ({
  editorFontSize: 14,
  terminalFontSize: 14,
  terminalCursorBlink: false,
  terminalLineHeight: 1.2,
  terminalScrollback: DEFAULT_TERMINAL_SCROLLBACK,
  terminalRenderer: "standard",
  setEditorFontSize: (size) => set({ editorFontSize: size }),
  setTerminalFontSize: (size) => set({ terminalFontSize: size }),
  setTerminalCursorBlink: (blink) => set({ terminalCursorBlink: blink }),
  setTerminalLineHeight: (height) => set({ terminalLineHeight: height }),
  setTerminalScrollback: (rows) =>
    set({ terminalScrollback: normalizeTerminalScrollback(rows) }),
  setTerminalRenderer: (renderer) => set({ terminalRenderer: renderer }),
});
