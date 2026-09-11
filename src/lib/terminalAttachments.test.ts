import { describe, expect, it } from "vitest";
import type { ClipboardAttachment } from "@/types";
import {
  MAX_PENDING_TERMINAL_ATTACHMENTS,
  canQueueTerminalAttachment,
  selectReadyTerminalAttachments,
} from "./terminalAttachments";

function attachment(overrides: Partial<ClipboardAttachment> = {}): ClipboardAttachment {
  return {
    attachmentId: "attachment-1",
    sessionId: "session-1",
    contentHash: "hash",
    path: "C:\\cache\\image.png",
    fileName: "image.png",
    mimeType: "image/png",
    sizeBytes: 1024,
    status: "ready",
    createdAt: 1,
    updatedAt: 1,
    available: true,
    ...overrides,
  };
}

describe("terminal attachments", () => {
  it("caps the pending attachment queue without counting inserted history", () => {
    const pending = Array.from({ length: MAX_PENDING_TERMINAL_ATTACHMENTS }, (_, index) =>
      attachment({ attachmentId: `attachment-${index}` }),
    );
    expect(canQueueTerminalAttachment(pending)).toBe(false);
    expect(canQueueTerminalAttachment([
      ...pending.slice(1),
      attachment({ attachmentId: "inserted", status: "inserted" }),
    ])).toBe(true);
  });

  it("only selects an available ready attachment for explicit insertion", () => {
    const attachments = [
      attachment({ attachmentId: "ready" }),
      attachment({ attachmentId: "saving", status: "saving" }),
      attachment({ attachmentId: "missing", available: false }),
    ];
    expect(selectReadyTerminalAttachments(attachments, "ready")).toHaveLength(1);
    expect(selectReadyTerminalAttachments(attachments, "saving")).toHaveLength(0);
    expect(selectReadyTerminalAttachments(attachments, "missing")).toHaveLength(0);
  });
});
