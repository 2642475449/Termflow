import { useEffect } from "react";
import { useAppStore } from "@/store";
import { useGitRemoteStore } from "@/store/slices/gitRemote";
import { gitRepoInfo } from "@/lib/api";

/** Remote polling has its own opt-in schedule; local refresh never starts it. */
export function useGitAutoFetch(path: string | null) {
  const enabled = useAppStore((s) => s.gitAutoFetch);
  const minutes = useAppStore((s) => s.gitAutoFetchIntervalMinutes);
  useEffect(() => {
    if (!path || !enabled) return;
    let disposed = false;
    let checking = false;
    const check = async () => {
      if (disposed || checking || document.visibilityState !== "visible") return;
      checking = true;
      try {
        const info = await gitRepoInfo(path);
        if (disposed || !info.isRepo) return;
        await useGitRemoteStore.getState().refresh(path);
        if (disposed || !useGitRemoteStore.getState().entries[path]?.data?.remotes.length) return;
        await useGitRemoteStore.getState().fetchUpdates(path, false, minutes * 60_000);
      } catch (error) {
        console.debug("[GitAutoFetch] Could not inspect repository", error);
      } finally { checking = false; }
    };
    void check();
    const timer = window.setInterval(() => void check(), 60_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [path, enabled, minutes]);
}
