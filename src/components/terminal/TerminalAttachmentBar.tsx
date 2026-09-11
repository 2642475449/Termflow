import { CopyOutlined, DeleteOutlined, EyeOutlined, LoadingOutlined } from "@ant-design/icons";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  formatTerminalAttachmentSize,
  isTerminalAttachmentActionable,
} from "@/lib/terminalAttachments";
import type { ClipboardAttachment } from "@/types";

interface TerminalAttachmentBarProps {
  attachments: ClipboardAttachment[];
  onCopyPath: (attachment: ClipboardAttachment) => void;
  onInsertPath: (attachment: ClipboardAttachment) => void;
  onPreview: (attachment: ClipboardAttachment) => void;
  onRemove: (attachment: ClipboardAttachment) => void;
  loadThumbnail: (attachment: ClipboardAttachment) => Promise<string>;
}

export function TerminalAttachmentBar({
  attachments,
  onCopyPath,
  onInsertPath,
  onPreview,
  onRemove,
  loadThumbnail,
}: TerminalAttachmentBarProps) {
  const { t } = useTranslation();
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>({});
  const thumbnailUrlsRef = useRef(thumbnailUrls);
  thumbnailUrlsRef.current = thumbnailUrls;

  useEffect(() => {
    let disposed = false;
    const activeIds = new Set(attachments.map((attachment) => attachment.attachmentId));
    setThumbnailUrls((current) => {
      const next = { ...current };
      Object.entries(next).forEach(([attachmentId, url]) => {
        if (activeIds.has(attachmentId)) return;
        URL.revokeObjectURL(url);
        delete next[attachmentId];
      });
      return next;
    });

    void (async () => {
      for (const attachment of attachments) {
        if (!isTerminalAttachmentActionable(attachment) || thumbnailUrlsRef.current[attachment.attachmentId]) {
          continue;
        }
        try {
          const previewDataUrl = await loadThumbnail(attachment);
          const thumbnailUrl = await createThumbnailUrl(previewDataUrl);
          if (disposed) {
            URL.revokeObjectURL(thumbnailUrl);
            return;
          }
          setThumbnailUrls((current) => {
            if (current[attachment.attachmentId]) {
              URL.revokeObjectURL(thumbnailUrl);
              return current;
            }
            return { ...current, [attachment.attachmentId]: thumbnailUrl };
          });
        } catch {
          // The action itself surfaces a scoped error. A missing thumbnail keeps
          // the attachment usable and avoids replacing the card with an alert.
        }
      }
    })();

    return () => {
      disposed = true;
    };
  }, [attachments, loadThumbnail]);

  useEffect(() => () => {
    Object.values(thumbnailUrlsRef.current).forEach((url) => URL.revokeObjectURL(url));
  }, []);

  if (attachments.length === 0) return null;

  return (
    <section className="app-terminal-attachment-bar" aria-label={t("terminal.attachmentsLabel")}>
      <div className="app-terminal-attachment-bar__heading">
        <span>{t("terminal.attachmentsLabel")}</span>
        <span className="app-terminal-attachment-bar__hint">{t("terminal.attachmentInsertHint")}</span>
      </div>
      <div className="app-terminal-attachment-bar__items">
        {attachments.map((attachment) => {
          const actionable = isTerminalAttachmentActionable(attachment);
          const canCopy = attachment.available && attachment.status !== "saving";
          const canRemove = attachment.status === "saving" || attachment.status === "ready" || attachment.status === "failed";
          const thumbnailUrl = thumbnailUrls[attachment.attachmentId];
          return (
            <article key={attachment.attachmentId} className="app-terminal-attachment-card">
              <button
                type="button"
                className="app-terminal-attachment-card__thumbnail"
                disabled={!attachment.available}
                title={t("terminal.openAttachmentPreview")}
                onClick={() => onPreview(attachment)}
              >
                {thumbnailUrl ? (
                  <img src={thumbnailUrl} alt="" />
                ) : attachment.status === "saving" || attachment.status === "inserting" ? (
                  <LoadingOutlined />
                ) : (
                  <EyeOutlined />
                )}
              </button>
              <div className="app-terminal-attachment-card__details">
                <div className="app-terminal-attachment-card__name" title={attachment.fileName}>
                  {attachment.fileName}
                </div>
                <div className="app-terminal-attachment-card__meta">
                  {formatTerminalAttachmentSize(attachment.sizeBytes)} · {t(`terminal.attachmentStatus.${attachment.status}`)}
                </div>
              </div>
              <div className="app-terminal-attachment-card__actions">
                <button
                  type="button"
                  className="app-terminal-attachment-card__action"
                  disabled={!actionable}
                  title={t("terminal.insertAttachmentPath")}
                  onClick={() => onInsertPath(attachment)}
                >
                  {t("terminal.insertAttachmentPath")}
                </button>
                <button
                  type="button"
                  className="app-terminal-attachment-card__icon-action"
                  disabled={!canCopy}
                  title={t("terminal.copyAttachmentPath")}
                  aria-label={t("terminal.copyAttachmentPath")}
                  onClick={() => onCopyPath(attachment)}
                >
                  <CopyOutlined />
                </button>
                <button
                  type="button"
                  className="app-terminal-attachment-card__icon-action"
                  disabled={!canRemove}
                  title={t("terminal.removeAttachment")}
                  aria-label={t("terminal.removeAttachment")}
                  onClick={() => onRemove(attachment)}
                >
                  <DeleteOutlined />
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

async function createThumbnailUrl(dataUrl: string): Promise<string> {
  const image = await loadImage(dataUrl);
  const scale = Math.min(1, 128 / image.naturalWidth, 88 / image.naturalHeight);
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Unable to create attachment thumbnail");
  context.drawImage(image, 0, 0, width, height);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Unable to encode attachment thumbnail")), "image/png");
  });
  return URL.createObjectURL(blob);
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to load attachment thumbnail"));
    image.src = source;
  });
}
