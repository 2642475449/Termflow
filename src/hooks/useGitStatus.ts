import { useCallback, useEffect, useRef } from "react";
import {
  GIT_STATUS_SNAPSHOT_EVENT,
  type GitStatusSnapshot,
} from "@/lib/gitStatusEvents";
import { useGitRemoteStore } from "@/store/slices/gitRemote";
import { EMPTY_GIT_STATUS, useGitStatusStore } from "@/store/slices/gitStatus";

interface UseGitStatusOptions {
  currentProject: { name: string; path: string } | null;
  onStatusChange?: (changeCount: number, ahead: number, behind: number) => void;
}

export function useGitStatus({
  currentProject,
  onStatusChange,
}: UseGitStatusOptions) {
  const path = currentProject?.path ?? null;
  const entry = useGitStatusStore((s) =>
    path ? (s.entries[path] ?? EMPTY_GIT_STATUS) : EMPTY_GIT_STATUS,
  );
  const refreshStore = useGitStatusStore((s) => s.refresh);
  const generation = useRef(0);
  const refreshWithRemote = useCallback(async (force: boolean) => {
    if (!path) return;
    await refreshStore(path);
    const status = useGitStatusStore.getState().entries[path];
    if (status?.isRepo && !status.error) await useGitRemoteStore.getState().fetchUpdates(path, force);
  }, [path, refreshStore]);
  const refresh = useCallback(() => refreshWithRemote(false), [refreshWithRemote]);
  const refreshAll = useCallback(() => refreshWithRemote(true), [refreshWithRemote]);
  useEffect(() => {
    void refresh();
    const check = () => { if (document.visibilityState === "visible") void refresh(); };
    const timer = window.setInterval(check, 60_000);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, [refresh]);
  useEffect(() => {
    generation.current = 0;
    const handler = (event: Event) => {
      const snapshot = (event as CustomEvent<GitStatusSnapshot>).detail;
      if (
        !snapshot ||
        snapshot.projectPath !== path ||
        snapshot.generation <= generation.current
      )
        return;
      generation.current = snapshot.generation;
      useGitStatusStore.getState().setSnapshot(snapshot);
    };
    window.addEventListener(GIT_STATUS_SNAPSHOT_EVENT, handler);
    return () => window.removeEventListener(GIT_STATUS_SNAPSHOT_EVENT, handler);
  }, [path]);
  useEffect(() => {
    onStatusChange?.(
      entry.fileStatuses.length,
      entry.branchInfo?.ahead ?? 0,
      entry.branchInfo?.behind ?? 0,
    );
  }, [entry.fileStatuses, entry.branchInfo, onStatusChange]);
  const { branchInfo, fileStatuses } = entry;
  return {
    ...entry,
    loading: entry.loading || (entry.isRepo === null && !entry.error),
    stagedFiles: fileStatuses.filter((f) => f.staged),
    unstagedFiles: fileStatuses.filter((f) => !f.staged),
    branchName: branchInfo?.branchName ?? "",
    hasLocalChanges: fileStatuses.length > 0,
    hasSyncChanges:
      (branchInfo?.ahead ?? 0) > 0 || (branchInfo?.behind ?? 0) > 0,
    syncChangeCount: (branchInfo?.ahead ?? 0) + (branchInfo?.behind ?? 0),
    refresh,
    refreshAll,
  };
}
