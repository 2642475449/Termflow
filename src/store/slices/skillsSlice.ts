import { create } from "zustand";
import type { SkillCatalog, SkillValidation } from "@/types";

export interface SkillEditorDraft {
  original: string;
  draft: string;
  validation: SkillValidation | null;
  validatedContent: string | null;
}

interface SkillsState {
  projectPath: string | null;
  catalog: SkillCatalog | null;
  loading: boolean;
  error: boolean;
  editors: Record<string, SkillEditorDraft>;
  setEditorLoaded: (key: string, content: string, force?: boolean) => void;
  setEditorDraft: (key: string, draft: string) => void;
  setEditorValidation: (key: string, content: string, validation: SkillValidation) => void;
  setEditorSaved: (key: string, submitted: string, content: string) => void;
  setProject: (path: string | null) => void;
  setCatalog: (path: string | null, catalog: SkillCatalog) => void;
  setLoading: (path: string | null, loading: boolean, error?: boolean) => void;
}

// 技能目录是文件系统快照，不持久化到 localStorage 或 SQLite。
export const useSkillsStore = create<SkillsState>((set) => ({
  projectPath: null, catalog: null, loading: true, error: false,
  editors: {},
  setEditorLoaded: (key, content, force = false) => set((state) => {
    const previous = state.editors[key];
    if (!force && previous && (previous.draft !== previous.original || previous.original === content)) return state;
    return { editors: { ...state.editors, [key]: { original: content, draft: content, validation: null, validatedContent: null } } };
  }),
  setEditorDraft: (key, draft) => set((state) => {
    const previous = state.editors[key];
    return previous ? { editors: { ...state.editors, [key]: { ...previous, draft, validation: null, validatedContent: null } } } : state;
  }),
  setEditorValidation: (key, content, validation) => set((state) => {
    const previous = state.editors[key];
    return previous?.draft === content ? { editors: { ...state.editors, [key]: { ...previous, validation, validatedContent: content } } } : state;
  }),
  setEditorSaved: (key, submitted, content) => set((state) => {
    const previous = state.editors[key];
    return previous ? { editors: { ...state.editors, [key]: { ...previous, original: content, draft: previous.draft === submitted ? content : previous.draft } } } : state;
  }),
  setProject: (projectPath) => set({ projectPath, catalog: null, loading: true, error: false }),
  setCatalog: (path, catalog) => set((state) => state.projectPath === path ? { catalog, error: false } : state),
  setLoading: (path, loading, error = false) => set((state) => state.projectPath === path ? { loading, error } : state),
}));
