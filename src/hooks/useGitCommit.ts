import { useCallback, useState } from "react";
import { message } from "antd";
import {
  gitCommit,
  gitCommitAmend,
  gitPull,
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
    default:
      return summary.detail;
  }
}

function getGitRefreshController() {
  return (window as unknown as Record<string, unknown>).__gitRefreshController as {
    requestRefresh: () => void;
    refreshNow: () => void;
    markOperationStart: () => void;
    markOperationEnd: () => void;
  } | undefined;
}

interface UseGitCommitOptions {
  projectPath: string | null;
  stagedFiles: GitFileStatus[];
  unstagedFiles: GitFileStatus[];
  ahead: number;
  behind: number;
  refresh: () => Promise<void>;
}

interface UseGitCommitReturn {
  committing: boolean;
  commit: (message: string) => Promise<void>;
  commitAmend: (message: string) => Promise<void>;
  commitAndPush: (message: string) => Promise<void>;
  commitAndSync: (message: string) => Promise<void>;
  pull: () => Promise<void>;
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
  ahead,
  behind,
  refresh,
}: UseGitCommitOptions): UseGitCommitReturn {
  const { t } = useTranslation();
  const [committing, setCommitting] = useState(false);

  const runGitOperation = useCallback(
    async (operation: () => Promise<void>) => {
      const controller = getGitRefreshController();
      controller?.markOperationStart();
      setCommitting(true);
      try {
        await operation();
      } finally {
        setCommitting(false);
        controller?.markOperationEnd();
      }
    },
    []
  );

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
      }
    });
  }, [projectPath, refresh, runGitOperation, t]);

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

  const sync = useCallback(async () => {
    if (!projectPath) return;

    const plan = getGitSyncPlan({ ahead, behind });
    if (plan.action === "none") return;

    await runGitOperation(async () => {
      if (plan.action === "push") {
        const pushResult = await gitPush(projectPath);
        if (!pushResult.success) {
          message.error(`${t("sidebar.gitPushFailed")}: ${formatGitRemoteError(pushResult.message, t)}`);
          return;
        }

        message.success(t("sidebar.gitPushSuccess"));
        await refreshGitStateAndGraph(projectPath, refresh);
        return;
      }

      const pullResult =
        plan.action === "pull-rebase-and-push"
          ? await gitPullRebase(projectPath)
          : await gitPull(projectPath);
      if (!pullResult.success) {
        message.error(`${t("sidebar.gitPullFailed")}: ${formatGitRemoteError(pullResult.message, t)}`);
        return;
      }

      if (plan.action === "pull") {
        message.success(t("sidebar.gitPullSuccess"));
        await refreshGitStateAndGraph(projectPath, refresh);
        return;
      }

      const pushResult = await gitPush(projectPath);
      if (!pushResult.success) {
        message.error(`${t("sidebar.gitPushFailed")}: ${formatGitRemoteError(pushResult.message, t)}`);
        await refreshGitStateAndGraph(projectPath, refresh);
        return;
      }

      message.success(t("sidebar.gitPushSuccess"));
      await refreshGitStateAndGraph(projectPath, refresh);
    });
  }, [ahead, behind, projectPath, refresh, runGitOperation, t]);

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
        }
        await refreshGitStateAndGraph(projectPath, refresh);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        message.error(`${t("sidebar.gitCommitFailed")}: ${detail}`);
        throw e;
      }
    });
  }, [projectPath, refresh, runGitOperation, stagedFiles, t, unstagedFiles]);

  const commitAndSync = useCallback(async (commitMessage: string) => {
    if (!projectPath) return;

    await runGitOperation(async () => {
      try {
        const files = await prepareFiles(projectPath, stagedFiles, unstagedFiles);
        await gitCommit(projectPath, commitMessage, files);
        await refresh();

        const pullResult = await gitPull(projectPath);
        if (!pullResult.success) {
          message.error(`${t("sidebar.gitPullFailed")}: ${formatGitRemoteError(pullResult.message, t)}`);
          await refreshGitStateAndGraph(projectPath, refresh);
          return;
        }

        const pushResult = await gitPush(projectPath);
        if (!pushResult.success) {
          message.error(`${t("sidebar.gitPushFailed")}: ${formatGitRemoteError(pushResult.message, t)}`);
          await refreshGitStateAndGraph(projectPath, refresh);
          return;
        }

        message.success(t("sidebar.gitCommitAndSync"));
        await refreshGitStateAndGraph(projectPath, refresh);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        message.error(`${t("sidebar.gitCommitFailed")}: ${detail}`);
        throw e;
      }
    });
  }, [projectPath, refresh, runGitOperation, stagedFiles, t, unstagedFiles]);

  return {
    committing,
    commit,
    commitAmend,
    commitAndPush,
    commitAndSync,
    pull,
    push,
    sync,
  };
}
