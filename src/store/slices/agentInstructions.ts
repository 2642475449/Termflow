import { create } from "zustand";
import { createProjectFile, readProjectFile, writeProjectFile } from "@/lib/api";
import type { AgentInstructionDocument, AgentInstructionsState } from "../types";

function emptyDocument(): AgentInstructionDocument {
  return {
    exists: null, content: "", draft: "", encoding: null,
    loading: false, saving: false, loaded: false, error: null,
  };
}

export const useAgentInstructionsStore = create<AgentInstructionsState>((set) => ({
  // 以完整路径隔离不同项目的同名指令文件。
  documents: {},
  setDraft: (filePath, draft) => set((state) => {
    const document = state.documents[filePath];
    if (!document?.loaded || document.loading || document.error) return state;
    return { documents: { ...state.documents, [filePath]: { ...document, draft } } };
  }),
}));

function updateDocument(filePath: string, changes: Partial<AgentInstructionDocument>): void {
  useAgentInstructionsStore.setState((state) => ({
    documents: {
      ...state.documents,
      [filePath]: { ...(state.documents[filePath] ?? emptyDocument()), ...changes },
    },
  }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function loadAgentInstructionFile(
  projectPath: string, filePath: string, force = false,
): Promise<void> {
  const document = useAgentInstructionsStore.getState().documents[filePath];
  if (document?.loading || document?.saving || (!force && document?.loaded)) return;
  updateDocument(filePath, { loading: true, error: null });
  try {
    // 文件 API 要求完整路径，不能传 AGENTS.md 等相对路径。
    const file = await readProjectFile(projectPath, filePath);
    updateDocument(filePath, {
      exists: true, content: file.content, draft: file.content, encoding: file.encoding,
      loading: false, loaded: true, error: null,
    });
  } catch (error) {
    const detail = errorMessage(error);
    // 只将后端明确返回的文件缺失视为可新建；权限、路径等错误保留给界面。
    if (detail === "目标路径不存在") {
      updateDocument(filePath, {
        exists: false, content: "", draft: "", encoding: null,
        loading: false, loaded: true, error: null,
      });
    } else {
      updateDocument(filePath, { loading: false, loaded: true, error: detail });
    }
  }
}

export async function saveAgentInstructionFile(projectPath: string, filePath: string): Promise<boolean> {
  const document = useAgentInstructionsStore.getState().documents[filePath];
  if (!document?.loaded || document.loading || document.saving || document.error) return false;
  updateDocument(filePath, { saving: true });
  try {
    if (document.exists === false) {
      const name = filePath.split(/[\\/]/).pop() ?? filePath;
      try {
        await createProjectFile(projectPath, projectPath, name);
      } catch (error) {
        // 文件可能在读取之后由外部编辑器创建。
        if (errorMessage(error) !== "同名文件或文件夹已存在") throw error;
      }
    }
    await writeProjectFile(projectPath, filePath, document.draft, document.encoding ?? undefined);
    // 保存期间的新编辑继续保留为草稿。
    updateDocument(filePath, { exists: true, content: document.draft });
    return true;
  } finally {
    updateDocument(filePath, { saving: false });
  }
}
