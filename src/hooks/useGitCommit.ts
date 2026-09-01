import { useCallback, useState } from "react";
import { message } from "antd";
import {
  gitCommit,
  gitCommitAmend,
  gitBranchInfo,
  gitFetch,
  gitPull,
  gitPullWithStash,
  gitPullRebase,
  gitPush,
} from "@/lib/api";
import { getGitSyncPlan } from "@/lib/gitSyncPolicy";
import { refreshGitStateAndGraph } from "@/lib/gitGraphEvents";
import { summarizeGitRemoteError } from "@/lib/gitRemoteError";
import type { GitFileStatus } from "@/types";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

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
  return (window as unknown as Record<string, unknown>).__gitRefreshController as {
    requestRefresh: () => void;
    refreshNow: () => void;
    markOperationStart: () => string;
    markOperationEnd: (operationId: string) => void;
  } | undefined;
}

interface UseGitCommitOptions {
  projectPath: string | null;
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
  unstagedFiles: GitFileStatus[]
): Promise<string[]> {
  if (stagedFiles.length === 0 && unstagedFiles.length > 0) {
    return Array.from(
      new Set(unstagedFiles.flatMap((file) => [file.oldPath, file.path].filter((path): path is string => !!path)))
    );
  }

  // Existing staged changes should be committed as-is without re-running git add.
  return [];
}

export function useGitCommit({
  projectPath,
  stagedFiles,
  unstagedFiles,
  refresh,
}: UseGitCommitOptions): UseGitCommitReturn {
  const { t } = useTranslation();
  const [committing, setCommitting] = useState(false);

  const runGitOperation = useCallback(
    async (operation: () => Promise<void>) => {
      const controller = getGitRefreshController();
      const operationId = controller?.markOperationStart();
      setCommitting(true);
      try {
        await operation();
      } finally {
        setCommitting(false);
        if (operationId) controller?.markOperationEnd(operationId);
      }
    },
    []
  );

  /**
   * 推送被拒绝后不能继续沿用旧的 ahead/behind。立即 fetch 并刷新图形与状态，
   * 让下一次同步根据远端最新引用重新决策。
   */
  const refreshAfterPushFailure = useCallback(async () => {
    if (!projectPath) return;
    try {
      await gitFetch(projectPath);
    } catch {
      // 保留原始推送错误；fetch 失败不应覆盖用户真正需要处理的原因。
    }
    await refreshGitStateAndGraph(projectPath, refresh);
  }, [projectPath, refresh]);

  const commit = useCallback(async (commitMessage: string) => {
    if (!projectPath) return;

    await runGitOperation(async () => {
      try {
        const files = await prepareFiles(projectPath, stagedFiles, unstagedFiles);
        await gitCommit(projectPath, commitMessage, files);
        message.success(t("sidebar.gitCommitSuccess"));
        await refreshGitStateAndGraph(projectPath, refresh);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        message.error(`${t("sidebar.gitCommitFailed")}: ${detail}`);
        throw e;
      }
    });
  }, [projectPath, refresh, runGitOperation, stagedFiles, t, unstagedFiles]);

  const commitAmend = useCallback(async (commitMessage: string) => {
    if (!projectPath) return;

    await runGitOperation(async () => {
      try {
        const files = await prepareFiles(projectPath, stagedFiles, unstagedFiles);
        await gitCommitAmend(projectPath, commitMessage, files);
        message.success(t("sidebar.gitAmendSuccess"));
        await refreshGitStateAndGraph(projectPath, refresh);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        message.error(`${t("sidebar.gitAmendFailed")}: ${detail}`);
        throw e;
      }
    });
  }, [projectPath, refresh, runGitOperation, stagedFiles, t, unstagedFiles]);

  const push = useCallback(async () => {
    if (!projectPath) return;

    await runGitOperation(async () => {
      const pushResult = await gitPush(projectPath);
      if (pushResult.success) {
        message.success(t("sidebar.gitPushSuccess"));
        await refreshGitStateAndGraph(projectPath, refresh);
      } else {
        message.error(`${t("sidebar.gitPushFailed")}: ${formatGitRemoteError(pushResult.message, t)}`);
        await refreshAfterPushFailure();
      }
    });
  }, [projectPath, refresh, refreshAfterPushFailure, runGitOperation, t]);

  const pull = useCallback(async () => {
    if (!projectPath) return;

    await runGitOperation(async () => {
      const pullResult = await gitPull(projectPath);
      if (pullResult.success) {
        message.success(t("sidebar.gitPullSuccess"));
        await refreshGitStateAndGraph(projectPath, refresh);
      } else {
        message.error(`${t("sidebar.gitPullFailed")}: ${formatGitRemoteError(pullResult.message, t)}`);
      }
    });
  }, [projectPath, refresh, runGitOperation, t]);

  const pullWithStash = useCallback(async () => {
    if (!projectPath) return;

    await runGitOperation(async () => {
      try {
        const result = await gitPullWithStash(projectPath);
        await refreshGitStateAndGraph(projectPath, refresh);

        if (!result.success) {
          message.error(`${t("sidebar.gitPullFailed")}: ${formatGitRemoteError(result.message, t)}`);
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

  /**
   * 手动同步的唯一入口：先更新远端跟踪引用，再使用刚刚读取的 ahead/behind 计算动作。
   */
  const syncWithLatestRemoteState = useCallback(async (showSuccess: boolean): Promise<boolean> => {
    if (!projectPath) return false;

    const fetchResult = await gitFetch(projectPath);
    if (!fetchResult.success) {
      message.error(`${t("sidebar.gitFetchFailed")}: ${formatGitRemoteError(fetchResult.message, t)}`);
      await refreshGitStateAndGraph(projectPath, refresh);
      return false;
    }

    const freshBranch = await gitBranchInfo(projectPath);
    const plan = getGitSyncPlan({
      ahead: freshBranch.ahead,
      behind: freshBranch.behind,
    });

    if (plan.action === "none") {
      await refreshGitStateAndGraph(projectPath, refresh);
      return true;
    }

    if (plan.action === "push") {
      const pushResult = await gitPush(projectPath);
      if (!pushResult.success) {
        message.error(`${t("sidebar.gitPushFailed")}: ${formatGitRemoteError(pushResult.message, t)}`);
        await refreshAfterPushFailure();
        return false;
      }
      if (showSuccess) message.success(t("sidebar.gitPushSuccess"));
      await refreshGitStateAndGraph(projectPath, refresh);
      return true;
    }

    const pullResult = plan.action === "pull-rebase-and-push"
      ? await gitPullRebase(projectPath)
      : await gitPull(projectPath);
    if (!pullResult.success) {
      message.error(`${t("sidebar.gitPullFailed")}: ${formatGitRemoteError(pullResult.message, t)}`);
      await refreshGitStateAndGraph(projectPath, refresh);
      return false;
    }

    if (plan.action === "pull") {
      if (showSuccess) message.success(t("sidebar.gitPullSuccess"));
      await refreshGitStateAndGraph(projectPath, refresh);
      return true;
    }

    const pushResult = await gitPush(projectPath);
    if (!pushResult.success) {
      message.error(`${t("sidebar.gitPushFailed")}: ${formatGitRemoteError(pushResult.message, t)}`);
      await refreshAfterPushFailure();
      return false;
    }

    if (showSuccess) message.success(t("sidebar.gitPushSuccess"));
    await refreshGitStateAndGraph(projectPath, refresh);
    return true;
  }, [projectPath, refresh, refreshAfterPushFailure, t]);

  const sync = useCallback(async () => {
    if (!projectPath) return;

    await runGitOperation(async () => {
      await syncWithLatestRemoteState(true);
    });
  }, [projectPath, runGitOperation, syncWithLatestRemoteState]);

  const commitAndPush = useCallback(async (commitMessage: string) => {
    if (!projectPath) return;

    await runGitOperation(async () => {
      try {
        const files = await prepareFiles(projectPath, stagedFiles, unstagedFiles);
        await gitCommit(projectPath, commitMessage, files);
        await refresh();

        const pushResult = await gitPush(projectPath);
        if (pushResult.success) {
          message.success(t("sidebar.gitPushSuccess"));
        } else {
          message.error(`${t("sidebar.gitPushFailed")}: ${formatGitRemoteError(pushResult.message, t)}`);
          await refreshAfterPushFailure();
          return;
        }
        await refreshGitStateAndGraph(projectPath, refresh);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        message.error(`${t("sidebar.gitCommitFailed")}: ${detail}`);
        throw e;
      }
    });
  }, [projectPath, refresh, refreshAfterPushFailure, runGitOperation, stagedFiles, t, unstagedFiles]);

  const commitAndSync = useCallback(async (commitMessage: string) => {
    if (!projectPath) return;

    await runGitOperation(async () => {
      try {
        const files = await prepareFiles(projectPath, stagedFiles, unstagedFiles);
        await gitCommit(projectPath, commitMessage, files);
        const synced = await syncWithLatestRemoteState(false);
        if (synced) message.success(t("sidebar.gitCommitAndSync"));
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        message.error(`${t("sidebar.gitCommitFailed")}: ${detail}`);
        throw e;
      }
    });
  }, [projectPath, runGitOperation, stagedFiles, syncWithLatestRemoteState, t, unstagedFiles]);

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
