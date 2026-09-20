import { create } from "zustand";

export interface FileEditorStatus {
  line: number;
  column: number;
  language: string;
  eol: "LF" | "CRLF";
  tabSize: number;
  insertSpaces: boolean;
}

interface FileEditorStatusState {
  editors: Record<string, FileEditorStatus>;
  setEditorStatus: (tabId: string, status: FileEditorStatus) => void;
  removeEditorStatus: (tabId: string) => void;
}

// 光标位置只属于当前窗口的编辑器实例，不持久化。
export const useFileEditorStatusStore = create<FileEditorStatusState>((set) => ({
  editors: {},
  setEditorStatus: (tabId, status) => set((state) => ({
    editors: { ...state.editors, [tabId]: status },
  })),
  removeEditorStatus: (tabId) => set((state) => {
    const editors = { ...state.editors };
    delete editors[tabId];
    return { editors };
  }),
}));
