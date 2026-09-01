import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { gitWatchStart, gitWatchStop } from "@/lib/api";

/** Git 文件变化事件载荷 */
interface GitFileChangePayload {
  projectPath: string;
  kind: string;
}

/** 将后端规范化后的 Windows 路径与前端项目路径稳定地比较。 */
function normalizeProjectPath(projectPath: string): string {
  return projectPath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Git 文件系统监听 Hook。
 *
 * 先订阅前端事件，再启动后端监听，避免启动窗口内丢失变更事件。
 */
export function useGitFileWatcher(
  projectPath: string | null,
  onFileChange: () => void,
  enabled: boolean = true
) {
  const onFileChangeRef = useRef(onFileChange);
  onFileChangeRef.current = onFileChange;

  useEffect(() => {
    if (!projectPath || !enabled) return;

    let unlisten: (() => void) | null = null;
    let watched = false;
    let cancelled = false;

    const stopWatcher = () => {
      if (!watched) return;
      watched = false;
      gitWatchStop(projectPath).catch((error) => {
        console.error("[useGitFileWatcher] Failed to stop watcher:", error);
      });
    };

    const setup = async () => {
      try {
        const unlistenHandler = await listen<GitFileChangePayload>(
          "git:file-change",
          (event) => {
            if (
              normalizeProjectPath(event.payload.projectPath) ===
              normalizeProjectPath(projectPath)
            ) {
              onFileChangeRef.current();
            }
          }
        );

        if (cancelled) {
          unlistenHandler();
          return;
        }

        unlisten = unlistenHandler;
        await gitWatchStart(projectPath);
        watched = true;

        // 卸载发生在启动过程中时，补做后端监听清理。
        if (cancelled) {
          if (unlisten === unlistenHandler) {
            unlistenHandler();
            unlisten = null;
          }
          stopWatcher();
        }
      } catch (error) {
        unlisten?.();
        unlisten = null;
        console.error("[useGitFileWatcher] Failed to setup watcher:", error);
      }
    };

    void setup();

    return () => {
      cancelled = true;
      const removeListener = unlisten;
      unlisten = null;
      removeListener?.();
      stopWatcher();
    };
  }, [projectPath, enabled]);
}
