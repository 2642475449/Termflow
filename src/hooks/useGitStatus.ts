import { useCallback, useEffect, useRef, useState } from "react";
import { gitBranchInfo, gitFetch, gitRepoInfo, gitStatus } from "@/lib/api";
import type { GitBranchInfo, GitFileStatus } from "@/types";
import { GIT_STATUS_SNAPSHOT_EVENT, type GitStatusSnapshot } from "@/lib/gitStatusEvents";
import { dispatchGitGraphRefresh } from "@/lib/gitGraphEvents";

const REMOTE_FETCH_INTERVAL_MS = 5 * 60 * 1000;

interface UseGitStatusOptions {
  currentProject: { name: string; path: string } | null;
  onStatusChange?: (changeCount: number, ahead: number, behind: number) => void;
}

interface UseGitStatusReturn {
  isRepo: boolean;
  loading: boolean;
  branchInfo: GitBranchInfo | null;
  fileStatuses: GitFileStatus[];
  stagedFiles: GitFileStatus[];
  unstagedFiles: GitFileStatus[];
  branchName: string;
  hasLocalChanges: boolean;
  hasSyncChanges: boolean;
  syncChangeCount: number;
  refresh: () => Promise<void>;
}

export function useGitStatus({
  currentProject,
  onStatusChange,
}: UseGitStatusOptions): UseGitStatusReturn {
  const [isRepo, setIsRepo] = useState(false);
  const [loading, setLoading] = useState(false);
  const [branchInfo, setBranchInfo] = useState<GitBranchInfo | null>(null);
  const [fileStatuses, setFileStatuses] = useState<GitFileStatus[]>([]);
  const requestSequenceRef = useRef(0);
  const activeProjectPathRef = useRef(currentProject?.path ?? null);
  const lastFetchRef = useRef<{ projectPath: string; fetchedAt: number } | null>(null);
  activeProjectPathRef.current = currentProject?.path ?? null;

  const refresh = useCallback(async () => {
    const requestId = ++requestSequenceRef.current;
    if (!currentProject) {
      setIsRepo(false);
      setBranchInfo(null);
      setFileStatuses([]);
      onStatusChange?.(0, 0, 0);
      return;
    }

    const projectPath = currentProject.path;
    const isCurrentRequest = () =>
      requestSequenceRef.current === requestId && activeProjectPathRef.current === projectPath;

    setLoading(true);
    try {
      const info = await gitRepoInfo(projectPath);
      if (!isCurrentRequest()) return;
      setIsRepo(info.isRepo);

      if (!info.isRepo) {
        setFileStatuses([]);
        setBranchInfo(null);
        onStatusChange?.(0, 0, 0);
        return;
      }

      const [statuses, branch] = await Promise.all([
        gitStatus(projectPath),
        gitBranchInfo(projectPath),
      ]);
      if (!isCurrentRequest()) return;

      setFileStatuses(statuses);
      setBranchInfo(branch);
      onStatusChange?.(statuses.length, branch.ahead ?? 0, branch.behind ?? 0);

      // Keep ahead/behind meaningful without blocking the local change list.
      const now = Date.now();
      const lastFetch = lastFetchRef.current;
      if (!lastFetch || lastFetch.projectPath !== projectPath || now - lastFetch.fetchedAt >= REMOTE_FETCH_INTERVAL_MS) {
        lastFetchRef.current = { projectPath, fetchedAt: now };
        void gitFetch(projectPath)
        .then((result) => {
          if (!result.success || !isCurrentRequest()) return null;
          dispatchGitGraphRefresh(projectPath);
          return gitBranchInfo(projectPath);
        })
        .then((freshBranch) => {
          if (!freshBranch || !isCurrentRequest()) return;
          setBranchInfo(freshBranch);
          onStatusChange?.(statuses.length, freshBranch.ahead ?? 0, freshBranch.behind ?? 0);
        })
        .catch(() => undefined);
      }
    } catch {
      if (!isCurrentRequest()) return;
      setIsRepo(false);
      setFileStatuses([]);
      setBranchInfo(null);
      onStatusChange?.(0, 0, 0);
    } finally {
      if (isCurrentRequest()) setLoading(false);
    }
  }, [currentProject, onStatusChange]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const handleSnapshot = (event: Event) => {
      const snapshot = (event as CustomEvent<GitStatusSnapshot>).detail;
      if (!snapshot || snapshot.projectPath !== activeProjectPathRef.current) return;
      requestSequenceRef.current += 1;
      setLoading(false);
      setIsRepo(snapshot.isRepo);
      setFileStatuses(snapshot.statuses);
      setBranchInfo(snapshot.branch);
      onStatusChange?.(
        snapshot.statuses.length,
        snapshot.branch?.ahead ?? 0,
        snapshot.branch?.behind ?? 0
      );
    };
    window.addEventListener(GIT_STATUS_SNAPSHOT_EVENT, handleSnapshot);
    return () => window.removeEventListener(GIT_STATUS_SNAPSHOT_EVENT, handleSnapshot);
  }, [onStatusChange]);

  const stagedFiles = fileStatuses.filter((f) => f.staged);
  const unstagedFiles = fileStatuses.filter((f) => !f.staged);
  const branchName = branchInfo?.branchName ?? "";
  const hasLocalChanges = fileStatuses.length > 0;
  const hasSyncChanges = (branchInfo?.ahead ?? 0) > 0 || (branchInfo?.behind ?? 0) > 0;
  const syncChangeCount = (branchInfo?.ahead ?? 0) + (branchInfo?.behind ?? 0);

  return {
    isRepo,
    loading,
    branchInfo,
    fileStatuses,
    stagedFiles,
    unstagedFiles,
    branchName,
    hasLocalChanges,
    hasSyncChanges,
    syncChangeCount,
    refresh,
  };
}
