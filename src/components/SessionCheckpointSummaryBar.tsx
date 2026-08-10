import {
  CheckCircleOutlined,
  RightOutlined,
  RollbackOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import { Tooltip } from "antd";
import { useTranslation } from "react-i18next";
import type { Session } from "@/types";
import {
  getCheckpointSummaryModel,
  openCheckpointReview,
  type CheckpointSummaryTone,
} from "@/lib/checkpointReview";

function toneColor(tone: CheckpointSummaryTone) {
  if (tone === "restored") return "var(--cs-text-tertiary)";
  if (tone === "reviewed") return "var(--cs-success)";
  return "var(--cs-primary)";
}

function ToneIcon({ tone }: { tone: CheckpointSummaryTone }) {
  if (tone === "restored") return <RollbackOutlined />;
  if (tone === "reviewed") return <CheckCircleOutlined />;
  return <SafetyCertificateOutlined />;
}

function SessionCheckpointSummaryBar({ session }: { session: Session }) {
  const { t } = useTranslation();
  const summary = getCheckpointSummaryModel(session);
  if (!summary) return null;

  const statusText = (() => {
    if (summary.tone === "partial") return t("checkpointReview.summary.partial");
    if (summary.tone === "reviewed") return t("checkpointReview.summary.reviewed");
    if (summary.tone === "restored") return t("checkpointReview.summary.restored");
    return t("checkpointReview.summary.pending", { count: summary.pendingTurns });
  })();
  const netLines = summary.netLines >= 0 ? `+${summary.netLines}` : String(summary.netLines);
  const tooltip = t("checkpointReview.summary.tooltip", {
    additions: summary.additions,
    deletions: summary.deletions,
    touched: summary.touchedLines,
    net: netLines,
  });
  const showStats = summary.files > 0;

  return (
    <Tooltip title={tooltip} mouseEnterDelay={0.45}>
      <button
        type="button"
        className="group flex h-[34px] w-full shrink-0 items-center gap-2 px-3 text-left text-[11px]"
        style={{
          color: "var(--cs-text-secondary)",
          background: "color-mix(in srgb, var(--cs-bg-sidebar) 62%, transparent)",
          borderBottom: "1px solid var(--cs-border-sidebar)",
        }}
        onClick={() => openCheckpointReview(session.id)}
        aria-label={t("checkpointReview.summary.open")}
      >
        <span
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md"
          style={{
            color: toneColor(summary.tone),
            background: `color-mix(in srgb, ${toneColor(summary.tone)} 10%, transparent)`,
          }}
        >
          <ToneIcon tone={summary.tone} />
        </span>

        <span className="shrink-0 font-medium" style={{ color: "var(--cs-text-primary)" }}>
          {t("checkpointReview.summary.title")}
        </span>

        {showStats && (
          <>
            <span style={{ color: "var(--cs-text-tertiary)" }}>·</span>
            <span>{t("checkpointReview.summary.files", { count: summary.files })}</span>
            <span className="font-medium" style={{ color: "var(--cs-success)" }}>
              +{summary.additions}
            </span>
            <span className="font-medium" style={{ color: "var(--cs-error)" }}>
              -{summary.deletions}
            </span>
          </>
        )}

        <span
          className="ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium"
          style={{
            color: toneColor(summary.tone),
            background: `color-mix(in srgb, ${toneColor(summary.tone)} 9%, transparent)`,
          }}
        >
          {statusText}
        </span>

        <RightOutlined
          style={{ color: "var(--cs-text-tertiary)", fontSize: 9 }}
        />
      </button>
    </Tooltip>
  );
}

export default SessionCheckpointSummaryBar;
