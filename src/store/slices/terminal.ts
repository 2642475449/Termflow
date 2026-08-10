import type { StateCreator } from "zustand";
import type { AppState } from "../types";

export interface TerminalSlice {
  editorFontSize: number;
  terminalFontSize: number;
  terminalCursorBlink: boolean;
  terminalLineHeight: number;
  terminalRenderer: "webgl" | "standard";
  setEditorFontSize: (size: number) => void;
  setTerminalFontSize: (size: number) => void;
  setTerminalCursorBlink: (blink: boolean) => void;
  setTerminalLineHeight: (height: number) => void;
  setTerminalRenderer: (renderer: "webgl" | "standard") => void;
}

export const createTerminalSlice: StateCreator<AppState, [], [], TerminalSlice> = (set) => ({
  editorFontSize: 14,
  terminalFontSize: 14,
  terminalCursorBlink: false,
  terminalLineHeight: 1.2,
  terminalRenderer: "standard",
  setEditorFontSize: (size) => set({ editorFontSize: size }),
  setTerminalFontSize: (size) => set({ terminalFontSize: size }),
  setTerminalCursorBlink: (blink) => set({ terminalCursorBlink: blink }),
  setTerminalLineHeight: (height) => set({ terminalLineHeight: height }),
  setTerminalRenderer: (renderer) => set({ terminalRenderer: renderer }),
});
