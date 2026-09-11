import { create } from "zustand";
import type { ClipboardAttachment } from "@/types";

interface TerminalAttachmentState {
  attachmentsBySession: Record<string, ClipboardAttachment[]>;
  setSessionAttachments: (sessionId: string, attachments: ClipboardAttachment[]) => void;
  upsertAttachment: (attachment: ClipboardAttachment) => void;
  removeAttachment: (sessionId: string, attachmentId: string) => void;
  clearSessionAttachments: (sessionId: string) => void;
}

// 空会话必须复用同一个快照，否则 Zustand 5 会触发 React 无限重渲染。
const EMPTY_ATTACHMENTS: ClipboardAttachment[] = [];

export function selectSessionAttachments(
  state: TerminalAttachmentState,
  sessionId: string,
): ClipboardAttachment[] {
  return state.attachmentsBySession[sessionId] ?? EMPTY_ATTACHMENTS;
}

/**
 * Attachment references are persisted by SQLite. This slice is deliberately a
 * non-persisted UI mirror, so blobs and base64 data never enter app storage.
 */
export const useTerminalAttachmentStore = create<TerminalAttachmentState>((set) => ({
  attachmentsBySession: {},
  setSessionAttachments: (sessionId, attachments) => set((state) => ({
    attachmentsBySession: {
      ...state.attachmentsBySession,
      [sessionId]: attachments,
    },
  })),
  upsertAttachment: (attachment) => set((state) => {
    const current = state.attachmentsBySession[attachment.sessionId] ?? [];
    const index = current.findIndex((item) => item.attachmentId === attachment.attachmentId);
    const next = index < 0
      ? [...current, attachment]
      : current.map((item, itemIndex) => itemIndex === index ? attachment : item);
    return {
      attachmentsBySession: {
        ...state.attachmentsBySession,
        [attachment.sessionId]: next,
      },
    };
  }),
  removeAttachment: (sessionId, attachmentId) => set((state) => ({
    attachmentsBySession: {
      ...state.attachmentsBySession,
      [sessionId]: (state.attachmentsBySession[sessionId] ?? []).filter(
        (attachment) => attachment.attachmentId !== attachmentId,
      ),
    },
  })),
  clearSessionAttachments: (sessionId) => set((state) => {
    const attachmentsBySession = { ...state.attachmentsBySession };
    delete attachmentsBySession[sessionId];
    return { attachmentsBySession };
  }),
}));
