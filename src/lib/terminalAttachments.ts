import type { ClipboardAttachment, TerminalAttachmentStatus } from "@/types";

export const MAX_PENDING_TERMINAL_ATTACHMENTS = 10;

const PENDING_ATTACHMENT_STATUSES = new Set<TerminalAttachmentStatus>([
  "saving",
  "ready",
  "inserting",
  "sending",
  "failed",
  "deliveryUnknown",
]);

export function isPendingTerminalAttachment(attachment: ClipboardAttachment): boolean {
  return PENDING_ATTACHMENT_STATUSES.has(attachment.status);
}

export function canQueueTerminalAttachment(attachments: ClipboardAttachment[]): boolean {
  return attachments.filter(isPendingTerminalAttachment).length < MAX_PENDING_TERMINAL_ATTACHMENTS;
}

export function selectReadyTerminalAttachments(
  attachments: ClipboardAttachment[],
  attachmentId: string,
): ClipboardAttachment[] {
  return attachments.filter((attachment) =>
    attachment.attachmentId === attachmentId
      && attachment.status === "ready"
      && attachment.available,
  );
}

export function isTerminalAttachmentActionable(attachment: ClipboardAttachment): boolean {
  return attachment.status === "ready" && attachment.available;
}

export function formatTerminalAttachmentSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}
