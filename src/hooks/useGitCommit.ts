import { useCallback } from "react";
import { message } from "antd";
import {
  gitCommit,
  gitCommitAmend,
  gitPullWithStash,
  gitRunWorkflow,
} from "@/lib/api";
import { useGitRemoteStore } from "@/store/slices/gitRemote";
import { getGitWorkflowOutcome } from "@/lib/gitWorkflowOutcome";
import { refreshGitStateAndGraph } from "@/lib/gitGraphEvents";
import { summarizeGitRemoteError } from "@/lib/gitRemoteError";
import type { GitFileStatus } from "@/types";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

class WorkflowReportedError extends Error {}

function formatGitRemoteError(rawMessage: string, t: TFunction): string {
  const summary = summarizeGitRemoteError(rawMessage);
  switch (summary.kind) {
    case "networkInterrupted":
      return t("sidebar.gitRemoteNetworkInterrupted");
    case "authenticationFailed":
      return t("sidebar.gitRemoteAuthenticationFailed");
    case "repositoryNotFound":
      return t("sidebar.gitRemoteRepositoryNotFound");
    case "timeout":
      return t("sidebar.gitRemoteTimeout");
    case "localChangesWouldBeOverwritten":
      return t("sidebar.gitPullLocalChangesBlocked");
    default:
      return summary.detail;
  }
}

function getGitRefreshController() {
  return (window as unknown as Record<string, unknown>)
    .__gitRefreshController as
    | {
        requestRefresh: () => void;
        refreshNow: () => void;
        markOperationStart: () => string;
        markOperationEnd: (operationId: string) => void;
      }
    | undefined;
}

interface UseGitCommitOptions {
  projectPath: string | null;
  expectedBranch: string;
  stagedFiles: GitFileStatus[];
  unstagedFiles: GitFileStatus[];
  refresh: () => Promise<void>;
}

interface UseGitCommitReturn {
  committing: boolean;
  commit: (message: string) => Promise<void>;
  commitAmend: (message: string) => Promise<void>;
  commitAndPush: (message: string) => Promise<void>;
  commitAndSync: (message: string) => Promise<void>;
  pull: () => Promise<void>;
  pullWithStash: () => Promise<void>;
  push: () => Promise<void>;
  sync: () => Promise<void>;
}

async function prepareFiles(
  _projectPath: string,
  stagedFiles: GitFileStatus[],
  unstagedFiles: GitFileStatus[],
): Promise<string[]> {
  if (stagedFiles.length === 0 && unstagedFiles.length > 0) {
    return Array.from(
      new Set(
        unstagedFiles.flatMap((file) =>
          [file.oldPath, file.path].filter((path): path is string => !!path),
        ),
      ),
    );
  }

  // Existing staged changes should be committed as-is without re-running git add.
  return [];
}

export function useGitCommit({
  projectPath,
  expectedBranch,
  stagedFiles,
  unstagedFiles,
  refresh,
}: UseGitCommitOptions): UseGitCommitReturn {
  const { t } = useTranslation();
  const committing = useGitRemoteStore((s) => !!s.busy[projectPath ?? ""]);

  const runGitOperation = useCallback(
    async (operation: () => Promise<void>, label = "commit") => {
      if (!projectPath) return;
      if (useGitRemoteStore.getState().busy[projectPath])
        throw new Error(t("sidebar.gitBusy"));
      useGitRemoteStore.getState().setBusy(projectPath, label);
      const controller = getGitRefreshController();
      const operationId = controller?.markOperationStart();

      try {
        await operation();
      } finally {
        useGitRemoteStore.getState().setBusy(projectPath, null);
        if (operationId) controller?.markOperationEnd(operationId);
      }
    },
    [projectPath, t],
  );

  const commit = useCallback(
    async (commitMessage: string) => {
      if (!projectPath) return;

      await runGitOperation(async () => {
        try {
          const files = await prepareFiles(
            projectPath,
            stagedFiles,
            unstagedFiles,
          );
          await gitCommit(projectPath, commitMessage, files);
          message.success(t("sidebar.gitCommitSuccess"));
          await refreshGitStateAndGraph(projectPath, refresh);
        } catch (e) {
          const detail = e instanceof Error ? e.message : String(e);
          message.error(`${t("sidebar.gitCommitFailed")}: ${detail}`);
          throw e;
        }
      });
    },
    [projectPath, refresh, runGitOperation, stagedFiles, t, unstagedFiles],
  );

  const commitAmend = useCallback(
    async (commitMessage: string) => {
      if (!projectPath) return;

      await runGitOperation(async () => {
        try {
          const files = await prepareFiles(
            projectPath,
            stagedFiles,
            unstagedFiles,
          );
          await gitCommitAmend(projectPath, commitMessage, files);
          message.success(t("sidebar.gitAmendSuccess"));
          await refreshGitStateAndGraph(projectPath, refresh);
        } catch (e) {
          const detail = e instanceof Error ? e.message : String(e);
          message.error(`${t("sidebar.gitAmendFailed")}: ${detail}`);
          throw e;
        }
      });
    },
    [projectPath, refresh, runGitOperation, stagedFiles, t, unstagedFiles],
  );

  const pullWithStash = useCallback(async () => {
    if (!projectPath) return;

    await runGitOperation(async () => {
      try {
        const result = await gitPullWithStash(projectPath);
        await refreshGitStateAndGraph(projectPath, refresh);

        if (!result.success) {
          message.error(
            `${t("sidebar.gitPullFailed")}: ${formatGitRemoteError(result.message, t)}`,
          );
          return;
        }

        if (result.restoreStatus === "conflicts") {
          message.warning(t("sidebar.gitPullRestoreConflicts"));
          return;
        }
        if (result.restoreStatus === "failed") {
          message.warning(t("sidebar.gitPullRestoreFailed"));
          return;
        }
        if (result.stashOid) {
          message.warning(t("sidebar.gitPullSuccessStashRetained"));
          return;
        }

        message.success(t("sidebar.gitPullWithStashSuccess"));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        message.error(`${t("sidebar.gitPullFailed")}: ${detail}`);
      }
    });
  }, [projectPath, refresh, runGitOperation, t]);

  const workflow = useCallback(
    async (
      action: "push" | "pull" | "sync" | "commit-and-push" | "commit-and-sync",
      commitMessage?: string,
    ) => {
      if (!projectPath) return;
      await runGitOperation(
        async () => {
          let committed = false;
          try {
            const result = await gitRunWorkflow({
              projectPath,
              expectedBranch,
              action,
              message: commitMessage,
              files:
                commitMessage === undefined
                  ? []
                  : await prepareFiles(projectPath, stagedFiles, unstagedFiles),
            });
            committed = !!result.commitOid;
            const outcome = getGitWorkflowOutcome(result);
            if (outcome === "partial") {
              message.warning(
                t("sidebar.gitCommitRemotePartial", {
                  oid: result.commitOid?.slice(0, 8),
                  detail: formatGitRemoteError(result.message, t),
                }),
              );
            } else if (outcome === "failed") {
              message.error(
                `${t("sidebar.remoteActions.failed")}: ${formatGitRemoteError(result.message, t)}`,
              );
              // 提交未发生时保留输入内容；提交成功后永远不提示重新提交。
              if (commitMessage !== undefined)
                throw new WorkflowReportedError(result.message);
            } else {
              message.success(
                t(
                  action === "pull"
                    ? "sidebar.gitPullSuccess"
                    : action === "push" || action === "commit-and-push"
                      ? "sidebar.gitPushSuccess"
                      : "sidebar.gitSyncSuccess",
                ),
              );
            }
          } catch (error) {
            // IPC 结果丢失时不能断言提交失败，更不能自动重复提交。
            if (!committed) {
              if (!(error instanceof WorkflowReportedError)) {
                message.error(
                  t("sidebar.gitWorkflowUnknown", { detail: String(error) }),
                );
              }
              throw error;
            }
          } finally {
            try {
              await refreshGitStateAndGraph(projectPath, refresh);
              await useGitRemoteStore.getState().refresh(projectPath);
            } catch (error) {
              message.warning(
                t("sidebar.gitRefreshFailed", { detail: String(error) }),
              );
            }
          }
        },
        action === "commit-and-push"
          ? "push"
          : action === "commit-and-sync"
            ? "sync"
            : action,
      );
    },
    [
      projectPath,
      expectedBranch,
      runGitOperation,
      refresh,
      stagedFiles,
      unstagedFiles,
      t,
    ],
  );

  const push = useCallback(() => workflow("push"), [workflow]);
  const pull = useCallback(() => workflow("pull"), [workflow]);
  const sync = useCallback(() => workflow("sync"), [workflow]);
  const commitAndPush = useCallback(
    (text: string) => workflow("commit-and-push", text),
    [workflow],
  );
  const commitAndSync = useCallback(
    (text: string) => workflow("commit-and-sync", text),
    [workflow],
  );

  return {
    committing,
    commit,
    commitAmend,
    commitAndPush,
    commitAndSync,
    pull,
    pullWithStash,
    push,
    sync,
  };
}
