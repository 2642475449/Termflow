import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Button, Popover, Tooltip, message } from "antd";
import {
  CloseOutlined,
  CopyOutlined,
  FileSearchOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import {
  generateContentOverview,
  getContentOverviewSnapshot,
  navigateToContentOverviewSection,
  subscribeContentOverview,
} from "@/lib/contentOverview";

interface ContentOverviewPopoverProps {
  sessionId: string;
  navigationId: string;
  isRunning: boolean;
}

export function ContentOverviewPopover({
  sessionId,
  navigationId,
  isRunning,
}: ContentOverviewPopoverProps) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const subscribe = useCallback(
    (listener: () => void) => subscribeContentOverview(sessionId, listener),
    [sessionId],
  );
  const getSnapshot = useCallback(() => getContentOverviewSnapshot(sessionId), [sessionId]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => setOpen(false), [sessionId]);
  useEffect(() => {
    if (!snapshot.canGenerate) setOpen(false);
  }, [snapshot.canGenerate]);
  useEffect(() => {
    if (
      !isRunning &&
      snapshot.canGenerate &&
      (!snapshot.overview || snapshot.overview.coverage === "partial")
    ) {
      generateContentOverview(sessionId, { partial: false });
    }
  }, [isRunning, sessionId, snapshot.canGenerate, snapshot.overview]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen && !snapshot.canGenerate) return;
    if (nextOpen && (!snapshot.overview || snapshot.contentUpdated)) {
      generateContentOverview(sessionId, { partial: isRunning });
    }
    setOpen(nextOpen);
  };

  const handleRegenerate = () => {
    generateContentOverview(sessionId, { partial: isRunning });
  };

  const handleCopy = async () => {
    const overview = getContentOverviewSnapshot(sessionId).overview;
    if (!overview) return;
    const sections = overview.sections.map((section) => section.title).join(" → ");
    const text = [
      overview.summary,
      ...overview.keyPoints.map((point) => `- ${point}`),
      sections ? `${t("contentOverview.sections")}: ${sections}` : "",
    ].filter(Boolean).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      message.success(t("contentOverview.copySuccess"));
    } catch (error) {
      console.error("Failed to copy content overview:", error);
      message.error(t("contentOverview.copyFailed"));
    }
  };

  const overview = snapshot.overview;
  const tooltip = t("contentOverview.tooltip");

  const content = overview ? (
    <div className="content-overview-panel">
      <div className="content-overview-header">
        <div>
          <div className="content-overview-title">{t("contentOverview.title")}</div>
          <div className="content-overview-time">
            {new Intl.DateTimeFormat(i18n.language, {
              hour: "2-digit",
              minute: "2-digit",
            }).format(overview.generatedAt)}
          </div>
        </div>
        <Tooltip title={t("common.collapse")} mouseEnterDelay={0.4}>
          <Button
            type="text"
            size="small"
            aria-label={t("common.collapse")}
            icon={<CloseOutlined />}
            onClick={() => setOpen(false)}
          />
        </Tooltip>
      </div>

      {(isRunning || overview.coverage === "partial" || snapshot.contentUpdated) && (
        <div className="content-overview-notice">
          {snapshot.contentUpdated
            ? t("contentOverview.updated")
            : isRunning
              ? t("contentOverview.running")
              : t("contentOverview.partial")}
        </div>
      )}

      <section>
        <div className="content-overview-label">{t("contentOverview.summary")}</div>
        <div className="content-overview-summary">{overview.summary}</div>
      </section>

      {overview.keyPoints.length > 0 && (
        <section>
          <div className="content-overview-label">{t("contentOverview.keyPoints")}</div>
          <ul className="content-overview-points">
            {overview.keyPoints.map((point) => <li key={point}>{point}</li>)}
          </ul>
        </section>
      )}

      {overview.sections.length > 0 && (
        <section>
          <div className="content-overview-label">{t("contentOverview.sections")}</div>
          <div className="content-overview-sections">
            {overview.sections.map((section) => (
              <button
                type="button"
                key={section.id}
                className="content-overview-section"
                style={{ paddingLeft: 9 + (section.level - 1) * 12 }}
                onClick={() => {
                  if (!navigateToContentOverviewSection(navigationId, section.anchorText)) {
                    message.warning(t("contentOverview.sectionNotFound"));
                    return;
                  }
                  setOpen(false);
                }}
              >
                {section.title}
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="content-overview-actions">
        <Button type="text" size="small" icon={<ReloadOutlined />} onClick={handleRegenerate}>
          {t("contentOverview.regenerate")}
        </Button>
        <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => void handleCopy()}>
          {t("contentOverview.copy")}
        </Button>
      </div>
    </div>
  ) : (
    <div className="content-overview-empty">{t("contentOverview.empty")}</div>
  );

  if (!snapshot.canGenerate) return null;

  return (
    <div className="content-overview-trigger-wrap">
      <Popover
        open={open}
        onOpenChange={handleOpenChange}
        trigger="click"
        placement="bottomRight"
        arrow={false}
        content={content}
        overlayClassName="content-overview-popover"
      >
        <Tooltip title={tooltip} mouseEnterDelay={0.4}>
          <span>
            <button
              type="button"
              className="content-overview-trigger"
              aria-label={t("contentOverview.title")}
              aria-expanded={open}
              data-open={open || undefined}
            >
              <FileSearchOutlined />
            </button>
          </span>
        </Tooltip>
      </Popover>
    </div>
  );
}
