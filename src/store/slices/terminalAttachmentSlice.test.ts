import { beforeEach, expect, it } from "vitest";
import { selectSessionAttachments, useTerminalAttachmentStore } from "./terminalAttachmentSlice";

beforeEach(() => {
  useTerminalAttachmentStore.setState({ attachmentsBySession: {} });
});

it("keeps the missing-session snapshot stable across reads and unrelated updates", () => {
  const snapshot = selectSessionAttachments(useTerminalAttachmentStore.getState(), "terminal-1");
  expect(snapshot).toEqual([]);
  expect(selectSessionAttachments(useTerminalAttachmentStore.getState(), "terminal-1")).toBe(snapshot);

  useTerminalAttachmentStore.getState().setSessionAttachments("terminal-2", []);
  expect(selectSessionAttachments(useTerminalAttachmentStore.getState(), "terminal-1")).toBe(snapshot);
});

it("returns the stored snapshot and restores the stable fallback after clearing a session", () => {
  const initial = selectSessionAttachments(useTerminalAttachmentStore.getState(), "terminal-1");
  const attachments: typeof initial = [];
  useTerminalAttachmentStore.getState().setSessionAttachments("terminal-1", attachments);
  expect(selectSessionAttachments(useTerminalAttachmentStore.getState(), "terminal-1")).toBe(attachments);

  useTerminalAttachmentStore.getState().clearSessionAttachments("terminal-1");
  expect(selectSessionAttachments(useTerminalAttachmentStore.getState(), "terminal-1")).toBe(initial);
});
