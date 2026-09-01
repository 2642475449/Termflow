import { useCallback, useState } from "react";
import { Button, Dropdown, Input, message, Modal, Tooltip } from "antd";
import type { MenuProps } from "antd";
import {
  CheckOutlined,
  DownOutlined,
  LoadingOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import type { GitCommitMessageProfile } from "@/types";

interface GitCommitComposerProps {
  branchName: string;
  hasLocalChanges: boolean;
  stagedChangeCount: number;
  unstagedChangeCount: number;
  aheadCount: number;
  behindCount: number;
  hasSyncChanges: boolean;
  syncChangeCount: number;
  committing: boolean;
  canGenerateCommitMessage: boolean;
  generateCommitMessageHint?: string;
  generatingCommitMessage: boolean;
  commitMessageProfiles: GitCommitMessageProfile[];
  defaultCommitMessageProfileId: string;
  onCommit: (message: string) => Promise<void>;
  onCommitAmend: (message: string) => Promise<void>;
  onCommitAndPush: (message: string) => Promise<void>;
  onCommitAndSync: (message: string) => Promise<void>;
  onPull: () => Promise<void>;
  onPullWithStash: () => Promise<void>;
  onSyncChanges: () => Promise<void>;
  onGenerateCommitMessage: (profileId?: string) => Promise<string | null>;
}

interface PendingCommitAction {
  action: (message: string) => Promise<void>;
  message: string;
}

export function GitCommitComposer({
  branchName,
  hasLocalChanges,
  stagedChangeCount,
  unstagedChangeCount,
  hasSyncChanges,
  syncChangeCount,
  committing,
  canGenerateCommitMessage,
  generateCommitMessageHint,
  generatingCommitMessage,
  commitMessageProfiles,
  defaultCommitMessageProfileId,
  onCommit,
  onCommitAmend,
  onCommitAndPush,
  onCommitAndSync,
  onPull,
  onPullWithStash,
  onSyncChanges,
  onGenerateCommitMessage,
}: GitCommitComposerProps) {
  const { t } = useTranslation();
  const [commitMessage, setCommitMessage] = useState("");
  const [pendingStageAllAction, setPendingStageAllAction] =
    useState<PendingCommitAction | null>(null);
  const [commitMenuOpen, setCommitMenuOpen] = useState(false);
  const [pullConfirmOpen, setPullConfirmOpen] = useState(false);

  const trimmedMessage = commitMessage.trim();
  const hasStagedChanges = stagedChangeCount > 0;
  const hasUnstagedChanges = unstagedChangeCount > 0;
  const willStageAllBeforeCommit = !hasStagedChanges && hasUnstagedChanges;
  const hasMixedChanges = hasStagedChanges && hasUnstagedChanges;
  const canCommit = !committing && hasLocalChanges && trimmedMessage.length > 0;
  const canSync =
    !committing && hasSyncChanges;
  const showSyncPrimaryAction = !hasLocalChanges && hasSyncChanges;
  const canOpenCommitMenu = !committing && (hasLocalChanges || hasSyncChanges);
  const canPrimaryAction = showSyncPrimaryAction ? canSync : canCommit;

  const syncActionText =
    syncChangeCount > 0
      ? `${t("sidebar.gitSyncChanges")} ${syncChangeCount}`
      : t("sidebar.gitSyncChanges");
  const primaryCommitText = willStageAllBeforeCommit
    ? t("sidebar.gitStageAllAndCommit", { defaultValue: "暂存并提交" })
    : t("sidebar.gitCommit");

  const commitDisabledReason = committing
    ? "Git 操作进行中，请稍候"
    : !hasLocalChanges
      ? t("sidebar.gitNoChanges")
      : !trimmedMessage
        ? t("sidebar.gitCommitEmptyMessage")
        : null;

  const syncDisabledReason = committing
    ? "Git 操作进行中，请稍候"
    : !hasSyncChanges
      ? "当前没有可同步的远程变更"
      : null;

  const commitMenuDisabledReason = committing
    ? "Git 操作进行中，请稍候"
    : !hasLocalChanges && !hasSyncChanges
      ? "当前没有可用的提交或同步操作"
      : null;

  const primaryActionDisabledReason = showSyncPrimaryAction
    ? syncDisabledReason
    : commitDisabledReason;

  const commitComposerBackground =
    "color-mix(in srgb, var(--cs-bg-card-solid, var(--cs-bg-card)) 93%, var(--cs-bg-sidebar) 7%)";
  const commitComposerBorder =
    "color-mix(in srgb, var(--cs-border-sidebar) 82%, transparent)";
  const commitComposerShadow = "none";

  const commitActionBackground = canPrimaryAction
    ? "color-mix(in srgb, var(--cs-primary) 9%, var(--cs-bg-card-solid, var(--cs-bg-card)) 91%)"
    : "color-mix(in srgb, var(--cs-bg-hover) 54%, var(--cs-bg-card-solid, var(--cs-bg-card)) 46%)";
  const commitActionBorder = canPrimaryAction
    ? "color-mix(in srgb, var(--cs-primary) 28%, var(--cs-border-sidebar) 72%)"
    : "color-mix(in srgb, var(--cs-border-sidebar) 82%, transparent)";
  const commitActionText = canPrimaryAction
    ? "color-mix(in srgb, var(--cs-primary) 64%, var(--cs-text-primary) 36%)"
    : "var(--cs-text-tertiary)";

  const executeCommitAction = useCallback(
    async (
      action: (message: string) => Promise<void>,
      messageText: string,
    ) => {
      try {
        await action(messageText);
        setCommitMessage("");
      } catch {
        // The Git operation owns its global Toast feedback.
      }
    },
    []
  );

  const runCommitAction = useCallback(
    async (action: (message: string) => Promise<void>) => {
      if (!trimmedMessage) {
        message.warning(t("sidebar.gitCommitEmptyMessage"));
        return;
      }
      if (!hasLocalChanges) {
        message.warning(t("sidebar.gitNoChanges"));
        return;
      }

      if (willStageAllBeforeCommit) {
        setPendingStageAllAction({
          action,
          message: trimmedMessage,
        });
        return;
      }

      await executeCommitAction(action, trimmedMessage);
    },
    [executeCommitAction, hasLocalChanges, t, trimmedMessage, willStageAllBeforeCommit]
  );

  const handleConfirmStageAllCommit = useCallback(() => {
    const pending = pendingStageAllAction;
    if (!pending) return;

    setPendingStageAllAction(null);
    void executeCommitAction(pending.action, pending.message);
  }, [executeCommitAction, pendingStageAllAction]);

  const handleCommit = useCallback(
    () => runCommitAction(onCommit),
    [onCommit, runCommitAction]
  );

  const handleCommitAmend = useCallback(
    () => runCommitAction(onCommitAmend),
    [onCommitAmend, runCommitAction]
  );

  const handleCommitAndPush = useCallback(
    () => runCommitAction(onCommitAndPush),
    [onCommitAndPush, runCommitAction]
  );

  const handleCommitAndSync = useCallback(
    () => runCommitAction(onCommitAndSync),
    [onCommitAndSync, runCommitAction]
  );

  const requestPull = useCallback(() => {
    setCommitMenuOpen(false);
    if (!hasLocalChanges) {
      void onPull();
      return;
    }

    // Give the Dropdown one render boundary to close before opening the Modal.
    window.setTimeout(() => setPullConfirmOpen(true), 0);
  }, [hasLocalChanges, onPull]);

  const handleConfirmPullWithStash = useCallback(async () => {
    await onPullWithStash();
    setPullConfirmOpen(false);
  }, [onPullWithStash]);

  const commitMenuItems: MenuProps["items"] = [
    {
      key: "commit",
      label: t("sidebar.gitCommit"),
      disabled: !canCommit,
    },
    {
      key: "commit-amend",
      label: t("sidebar.gitCommitAmend"),
      disabled: !canCommit,
    },
    {
      key: "commit-and-push",
      label: t("sidebar.gitCommitAndPush"),
      disabled: !canCommit,
    },
    {
      key: "commit-and-sync",
      label: t("sidebar.gitCommitAndSync"),
      disabled: !canCommit,
    },
    { type: "divider" },
    {
      key: "pull",
      label: t("sidebar.gitPull"),
      disabled: committing,
    },
    {
      key: "sync-changes",
      label: t("sidebar.gitSyncChanges"),
      disabled: !canSync,
      title: syncDisabledReason ?? undefined,
    },
  ];

  const handleCommitMenuClick = useCallback(
    ({ key }: { key: string }) => {
      switch (key) {
        case "commit":
          void handleCommit();
          break;
        case "commit-amend":
          void handleCommitAmend();
          break;
        case "commit-and-push":
          void handleCommitAndPush();
          break;
        case "commit-and-sync":
          void handleCommitAndSync();
          break;
        case "pull":
          requestPull();
          break;
        case "sync-changes":
          void onSyncChanges();
          break;
        default:
          break;
      }
    },
    [handleCommit, handleCommitAmend, handleCommitAndPush, handleCommitAndSync, onSyncChanges, requestPull]
  );

  const handleGenerateCommitMessage = useCallback(async (profileId?: string) => {
    if (!canGenerateCommitMessage || generatingCommitMessage) return;
    try {
      const generatedMessage = await onGenerateCommitMessage(profileId);
      if (generatedMessage?.trim()) {
        setCommitMessage(generatedMessage.trim());
      }
    } catch {
      // The generator owns its global Toast feedback.
    }
  }, [canGenerateCommitMessage, generatingCommitMessage, onGenerateCommitMessage]);

  const defaultCommitMessageProfile = commitMessageProfiles.find(
    (profile) => profile.id === defaultCommitMessageProfileId,
  ) ?? commitMessageProfiles[0];
  const commitMessageProfileMenuItems: MenuProps["items"] = commitMessageProfiles.map(
    (profile) => ({
      key: profile.id,
      label: (
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate">{profile.name}</span>
          {profile.id === defaultCommitMessageProfileId && (
            <span className="text-[10px]" style={{ color: "var(--cs-text-tertiary)" }}>
              {t("sidebar.gitCommitMessageProfileDefault")}
            </span>
          )}
        </span>
      ),
    }),
  );

  return (
    <div className="shrink-0 px-2 pb-1.5 pt-1.5">
      <div
        className="git-commit-composer mb-2 overflow-hidden rounded-[8px]"
        style={{
          background: commitComposerBackground,
          border: `1px solid ${commitComposerBorder}`,
          boxShadow: commitComposerShadow,
          transition: "border-color 150ms ease, box-shadow 150ms ease",
        }}
      >
        <div className="flex items-start px-2.5 pt-2 pb-1">
          <Input.TextArea
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            placeholder={t("sidebar.gitCommitPlaceholder", { branch: branchName })}
            autoSize={{ minRows: 2, maxRows: 8 }}
            bordered={false}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && canCommit) {
                e.preventDefault();
                void handleCommit();
              }
            }}
            onFocus={(e) => {
              const container = e.currentTarget.closest(".git-commit-composer") as HTMLElement | null;
              if (container) {
                container.style.borderColor = "var(--cs-primary)";
                container.style.boxShadow = "0 0 0 1px color-mix(in srgb, var(--cs-primary) 22%, transparent)";
              }
            }}
            onBlur={(e) => {
              const container = e.currentTarget.closest(".git-commit-composer") as HTMLElement | null;
              if (container) {
                container.style.borderColor = commitComposerBorder;
                container.style.boxShadow = commitComposerShadow;
              }
            }}
            style={{
              flex: 1,
              padding: 0,
              fontSize: 13,
              lineHeight: 1.5,
              background: "transparent",
              color: "var(--cs-text-primary)",
              minHeight: 0,
            }}
          />
          <div className="ml-1 flex shrink-0 items-center">
            <Tooltip
              title={
                generatingCommitMessage
                  ? t("sidebar.gitGenerateCommitMessageLoading")
                  : `${generateCommitMessageHint ?? t("sidebar.gitGenerateCommitMessage")} · ${defaultCommitMessageProfile?.name ?? ""}`
              }
              mouseEnterDelay={0.4}
            >
              <Button
                type="text"
                size="small"
                onClick={() => void handleGenerateCommitMessage()}
                disabled={!canGenerateCommitMessage}
                style={{
                  width: 24,
                  height: 24,
                  padding: 0,
                  color: canGenerateCommitMessage
                    ? "color-mix(in srgb, var(--cs-primary) 76%, var(--cs-text-primary) 24%)"
                    : "var(--cs-text-tertiary)",
                }}
              >
                {generatingCommitMessage ? (
                  <LoadingOutlined />
                ) : (
                  <span className="text-[11px] font-semibold tracking-[0.02em]">AI</span>
                )}
              </Button>
            </Tooltip>
            <Dropdown
              trigger={["click"]}
              disabled={!canGenerateCommitMessage}
              menu={{
                items: commitMessageProfileMenuItems,
                onClick: ({ key }) => void handleGenerateCommitMessage(key),
              }}
              placement="bottomRight"
            >
              <Button
                type="text"
                size="small"
                aria-label={t("sidebar.gitChooseCommitMessageProfile")}
                icon={<DownOutlined className="text-[9px]" />}
                style={{
                  width: 18,
                  height: 24,
                  padding: 0,
                  color: canGenerateCommitMessage
                    ? "var(--cs-text-secondary)"
                    : "var(--cs-text-tertiary)",
                }}
              />
            </Dropdown>
          </div>
        </div>
      </div>

      {showSyncPrimaryAction ? (
        <Tooltip title={canSync ? syncActionText : primaryActionDisabledReason} mouseEnterDelay={0.4}>
          <span className="block w-full">
            <Button
              block
              size="large"
              icon={<ReloadOutlined />}
              loading={committing}
              disabled={!canSync}
              onClick={onSyncChanges}
              style={{
                height: 28,
                borderRadius: 8,
                borderColor: commitActionBorder,
                background: commitActionBackground,
                color: commitActionText,
                fontFamily: "inherit",
                fontSize: 13,
                lineHeight: 1.2,
                fontWeight: 600,
                letterSpacing: "0.01em",
                cursor: canSync ? "pointer" : "not-allowed",
                opacity: canSync ? 1 : 0.7,
                boxShadow: "none",
              }}
            >
              <span>{syncActionText}</span>
            </Button>
          </span>
        </Tooltip>
      ) : (
        <div className="flex w-full items-stretch">
          <Tooltip title={canCommit ? primaryCommitText : primaryActionDisabledReason} mouseEnterDelay={0.4}>
            <span className="flex-1">
              <Button
                className="flex-1 rounded-r-none"
                size="large"
                icon={<CheckOutlined />}
                loading={committing}
                disabled={!canCommit}
                onClick={handleCommit}
                style={{
                  width: "100%",
                  height: 28,
                  borderRadius: "8px 0 0 8px",
                  borderColor: commitActionBorder,
                  background: commitActionBackground,
                  color: commitActionText,
                  fontFamily: "inherit",
                  fontSize: 13,
                  lineHeight: 1.2,
                  fontWeight: 600,
                  letterSpacing: "0.01em",
                  cursor: canCommit ? "pointer" : "not-allowed",
                  opacity: canCommit ? 1 : 0.7,
                  boxShadow: "none",
                }}
              >
                <span>{primaryCommitText}</span>
              </Button>
            </span>
          </Tooltip>
          <Dropdown
            trigger={["click"]}
            menu={{ items: commitMenuItems, onClick: handleCommitMenuClick }}
            open={commitMenuOpen}
            onOpenChange={setCommitMenuOpen}
          >
            <Tooltip title={canOpenCommitMenu ? t("sidebar.moreActions", { defaultValue: "更多提交操作" }) : commitMenuDisabledReason} mouseEnterDelay={0.4}>
              <span>
                <Button
                  className="rounded-l-none"
                  size="large"
                  disabled={!canOpenCommitMenu}
                  style={{
                    width: 36,
                    height: 28,
                    paddingInline: 0,
                    borderRadius: "0 8px 8px 0",
                    borderColor: canOpenCommitMenu ? commitActionBorder : "color-mix(in srgb, var(--cs-border-sidebar) 70%, var(--cs-text-primary) 10%)",
                    borderLeftColor: canOpenCommitMenu
                      ? "color-mix(in srgb, var(--cs-primary) 46%, var(--cs-border-sidebar) 54%)"
                      : "color-mix(in srgb, var(--cs-border-sidebar) 70%, var(--cs-text-primary) 10%)",
                    background: canOpenCommitMenu
                      ? "color-mix(in srgb, var(--cs-primary) 9%, var(--cs-bg-card-solid, var(--cs-bg-card)) 91%)"
                      : "color-mix(in srgb, var(--cs-bg-hover) 54%, var(--cs-bg-card-solid, var(--cs-bg-card)) 46%)",
                    color: canOpenCommitMenu
                      ? "color-mix(in srgb, var(--cs-primary) 64%, var(--cs-text-primary) 36%)"
                      : "var(--cs-text-tertiary)",
                    cursor: canOpenCommitMenu ? "pointer" : "not-allowed",
                    opacity: canOpenCommitMenu ? 1 : 0.7,
                    boxShadow: "none",
                  }}
                >
                  <DownOutlined className="text-[10px]" />
                </Button>
              </span>
            </Tooltip>
          </Dropdown>
        </div>
      )}

      {hasMixedChanges ? (
        <div
          className="mt-1.5 px-1 text-[11px] leading-[1.4]"
          style={{
            color: "var(--cs-text-tertiary)",
            userSelect: "text",
            WebkitUserSelect: "text",
            cursor: "text",
          }}
        >
          {t("sidebar.gitCommitStagedOnlyHint", {
            defaultValue: "将仅提交已暂存更改，未暂存更改会保留。",
          })}
        </div>
      ) : null}
      <Modal
        title={t("sidebar.gitStageAllCommitConfirmTitle", {
          defaultValue: "暂存所有更改并提交？",
        })}
        open={pendingStageAllAction !== null}
        okText={t("sidebar.gitStageAllAndCommit", { defaultValue: "暂存并提交" })}
        cancelText={t("common.cancel")}
        confirmLoading={committing}
        onOk={handleConfirmStageAllCommit}
        onCancel={() => setPendingStageAllAction(null)}
      >
        <p>
          {t("sidebar.gitStageAllCommitConfirmContent", {
            count: unstagedChangeCount,
            defaultValue: "当前没有已暂存文件，将先暂存全部未暂存更改，再执行提交。",
          })}
        </p>
      </Modal>
      <Modal
        title={t("sidebar.gitPullWithStashTitle")}
        open={pullConfirmOpen}
        okText={t("sidebar.gitPullWithStashAction")}
        cancelText={t("common.cancel")}
        confirmLoading={committing}
        cancelButtonProps={{ disabled: committing }}
        closable={!committing}
        maskClosable={!committing}
        onOk={() => void handleConfirmPullWithStash()}
        onCancel={() => setPullConfirmOpen(false)}
      >
        <p>{t("sidebar.gitPullWithStashDescription")}</p>
        <p className="mt-2 text-xs text-[color:var(--cs-text-secondary)]">
          {t("sidebar.gitPullWithStashSummary", {
            staged: stagedChangeCount,
            unstaged: unstagedChangeCount,
          })}
        </p>
      </Modal>
    </div>
  );
}
