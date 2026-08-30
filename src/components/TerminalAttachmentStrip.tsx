import { Badge } from "antd";
import { CloseOutlined, PictureOutlined, ShrinkOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import type { TerminalImageAttachment } from "@/lib/terminalImageAttachments";

interface TerminalAttachmentStripProps {
  previews: TerminalImageAttachment[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpenPreview: (id: string) => void;
  onRemove: (id: string) => void;
}

export function TerminalAttachmentStrip({
  previews,
  collapsed,
  onToggleCollapsed,
  onOpenPreview,
  onRemove,
}: TerminalAttachmentStripProps) {
  const { t } = useTranslation();

  if (collapsed) {
    return (
      <button
        type="button"
        className="app-terminal-attachment-rail"
        title={t("terminal.imageStripExpand")}
        aria-label={t("terminal.imageStripTitle", { count: previews.length })}
        onClick={onToggleCollapsed}
      >
        <Badge count={previews.length} size="small" offset={[-2, 2]}>
          <PictureOutlined style={{ fontSize: 15 }} />
        </Badge>
      </button>
    );
  }

  return (
    <aside className="app-terminal-attachment-strip">
      <div className="flex items-center justify-between gap-1 px-2 pt-2 pb-1">
        <span
          className="truncate text-xs"
          style={{ color: "var(--cs-text-secondary)" }}
          title={t("terminal.imageStripTitle", { count: previews.length })}
        >
          {t("terminal.imageStripTitle", { count: previews.length })}
        </span>
        <button
          type="button"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded border-0 p-0"
          style={{ background: "transparent", color: "var(--cs-text-secondary)", cursor: "pointer" }}
          title={t("terminal.imageStripCollapse")}
          aria-label={t("terminal.imageStripCollapse")}
          onClick={onToggleCollapsed}
        >
          <ShrinkOutlined style={{ fontSize: 11 }} />
        </button>
      </div>
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {previews.map((preview) => (
          <div
            key={preview.id}
            className="group relative h-[92px] shrink-0 overflow-visible rounded-[10px] border p-1.5 shadow-sm"
            style={{
              borderColor: "var(--cs-border)",
              background: "var(--cs-bg-card-solid, rgba(255,255,255,0.98))",
            }}
          >
            <button
              type="button"
              className="block h-full w-full overflow-hidden rounded-[6px] border-0 p-0"
              style={{ background: "color-mix(in srgb, var(--cs-bg-sidebar) 88%, transparent)", cursor: "pointer" }}
              title={t("terminal.openPastedImagePreview")}
              onClick={() => onOpenPreview(preview.id)}
            >
              <img src={preview.src} alt={preview.alt} className="block h-full w-full object-contain" />
            </button>
            <button
              type="button"
              className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full border opacity-0 shadow-md transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
              style={{
                borderColor: "var(--cs-border)",
                background: "var(--cs-bg-card-solid, #fff)",
                color: "var(--cs-text-secondary)",
                cursor: "pointer",
              }}
              title={t("terminal.closePastedImagePreview")}
              aria-label={t("terminal.closePastedImagePreview")}
              onClick={() => onRemove(preview.id)}
            >
              <CloseOutlined style={{ fontSize: 9 }} />
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}

export default TerminalAttachmentStrip;
