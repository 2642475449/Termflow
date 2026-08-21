import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Alert, Button, Input, Modal } from "antd";
import { useTranslation } from "react-i18next";
import { AgentIcon } from "@/components/AgentIcon";
import {
  RESOURCE_SIDE_QUESTION_PRESETS,
  SIDE_QUESTION_PRESETS,
  canSubmitSideQuestion,
  type SideQuestionContext,
} from "@/lib/sideQuestion";
import type { AgentCliInfo } from "@/types";

interface SideQuestionComposerProps {
  open: boolean;
  agent: AgentCliInfo | null;
  context: SideQuestionContext | null;
  question: string;
  onQuestionChange: (question: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

export function SideQuestionComposer({
  open,
  agent,
  context,
  question,
  onQuestionChange,
  onCancel,
  onSubmit,
}: SideQuestionComposerProps) {
  const { t } = useTranslation();
  const canSubmit = Boolean(agent && canSubmitSideQuestion(question, context));
  const isResourceQuestion = context?.kind === "resources";
  const presets = isResourceQuestion ? RESOURCE_SIDE_QUESTION_PRESETS : SIDE_QUESTION_PRESETS;

  const handleQuestionKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && canSubmit) {
      event.preventDefault();
      onSubmit();
    }
  };

  return (
    <Modal
      open={open}
      title={
        <span className="flex items-center gap-2">
          {agent ? <AgentIcon agentId={agent.id} size={17} /> : null}
          <span>{t("terminal.sideQuestionComposerTitle", { agent: agent?.name ?? "" })}</span>
        </span>
      }
      width={640}
      okText={t("terminal.sendQuestion")}
      cancelText={t("common.cancel")}
      okButtonProps={{ disabled: !canSubmit }}
      onOk={onSubmit}
      onCancel={onCancel}
      destroyOnHidden
    >
      <div className="flex flex-col gap-4 py-2">
        <div>
          <label
            className="mb-1.5 block text-sm font-medium"
            style={{ color: "var(--cs-text-secondary)" }}
          >
            {t("terminal.sideQuestionQuestionLabel")}
          </label>
          <Input.TextArea
            autoFocus
            value={question}
            onChange={(event) => onQuestionChange(event.target.value)}
            onKeyDown={handleQuestionKeyDown}
            placeholder={t(
              isResourceQuestion
                ? "sidebar.sideQuestionQuestionPlaceholder"
                : "terminal.sideQuestionQuestionPlaceholder"
            )}
            autoSize={{ minRows: 3, maxRows: 8 }}
            maxLength={4000}
            showCount
          />
          <div className="mt-1 text-xs" style={{ color: "var(--cs-text-tertiary)" }}>
            {t("terminal.sideQuestionSubmitHint")}
          </div>
        </div>

        <div>
          <div className="mb-2 text-sm" style={{ color: "var(--cs-text-secondary)" }}>
            {t("terminal.sideQuestionQuickQuestions")}
          </div>
          <div className="flex flex-wrap gap-2">
            {presets.map((preset) => {
              const presetQuestion = t(preset.questionKey);
              return (
                <Button
                  key={preset.id}
                  size="small"
                  type={question === presetQuestion ? "primary" : "default"}
                  onClick={() => onQuestionChange(presetQuestion)}
                >
                  {t(preset.labelKey)}
                </Button>
              );
            })}
          </div>
        </div>

        {context?.kind === "terminal" ? (
          <div>
            <div className="mb-2 flex items-center justify-between gap-3 text-sm">
              <span style={{ color: "var(--cs-text-secondary)" }}>
                {t("terminal.sideQuestionSelectionPreview")}
              </span>
              <span className="text-xs" style={{ color: "var(--cs-text-tertiary)" }}>
                {t("terminal.sideQuestionSelectionMeta", { count: context.selection.lineCount })}
              </span>
            </div>
            <pre
              className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border p-3 text-xs"
              style={{
                borderColor: "var(--cs-border-secondary)",
                background: "var(--cs-bg-hover)",
                color: "var(--cs-text-secondary)",
                fontFamily: "monospace",
              }}
            >
              {context.selection.text}
            </pre>
            {context.selection.truncated ? (
              <div className="mt-1.5 text-xs" style={{ color: "var(--cs-warning, #d89614)" }}>
                {t("terminal.sideQuestionTruncatedDraft")}
              </div>
            ) : null}
          </div>
        ) : null}

        {context?.kind === "resources" ? (
          <div>
            <div className="mb-2 flex items-center justify-between gap-3 text-sm">
              <span style={{ color: "var(--cs-text-secondary)" }}>
                {t("sidebar.sideQuestionResourcePreview")}
              </span>
              <span className="text-xs" style={{ color: "var(--cs-text-tertiary)" }}>
                {t("sidebar.sideQuestionResourceMeta", {
                  count: context.resourceContext.totalCount,
                })}
              </span>
            </div>
            <div
              className="max-h-40 overflow-auto rounded-md border p-2"
              style={{
                borderColor: "var(--cs-border-secondary)",
                background: "var(--cs-bg-hover)",
              }}
            >
              {context.resourceContext.resources.map((resource) => (
                <div
                  key={`${resource.kind}:${resource.path}`}
                  className="flex min-w-0 items-center gap-2 px-1 py-1 text-xs"
                  style={{ color: "var(--cs-text-secondary)" }}
                >
                  <span className="shrink-0" style={{ color: "var(--cs-text-tertiary)" }}>
                    {t(
                      resource.kind === "directory"
                        ? "sidebar.sideQuestionResourceDirectory"
                        : "sidebar.sideQuestionResourceFile"
                    )}
                  </span>
                  <code className="min-w-0 break-all">{resource.path}</code>
                </div>
              ))}
            </div>
            {context.resourceContext.truncated ? (
              <div className="mt-1.5 text-xs" style={{ color: "var(--cs-warning, #d89614)" }}>
                {t("sidebar.sideQuestionResourcesTruncated", {
                  count: context.resourceContext.resources.length,
                })}
              </div>
            ) : null}
          </div>
        ) : null}

        {context?.kind === "resources" && context.resourceContext.containsDirectory ? (
          <Alert
            type="info"
            showIcon
            message={t("sidebar.sideQuestionDirectoryTitle")}
            description={t("sidebar.sideQuestionDirectoryHint")}
          />
        ) : null}

        {context?.kind === "terminal" && context.selection.potentialSecret ? (
          <Alert
            type="warning"
            showIcon
            message={t("terminal.sensitiveSideQuestionTitle")}
            description={t("terminal.sensitiveSideQuestionDraftHint")}
          />
        ) : null}
      </div>
    </Modal>
  );
}
