import { useCallback } from "react";
import { message } from "antd";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@/store";
import { cleanupSessionProcess, resolveRecentCodexSessionId, spawnPty } from "@/lib/api";
import { getAgentCommandShell, getAgentStartupCommand, isAiAgentId } from "@/lib/agents";
import type { SessionLaunchOptions } from "@/types";

class CodexSessionRestoreError extends Error {}

export function useResumeSession() {
  const { t } = useTranslation();
  const defaultTerminalShell = useAppStore((state) => state.defaultTerminalShell);
  const updateSession = useAppStore((state) => state.updateSession);

  return useCallback(async (sessionId: string) => {
    const session = useAppStore.getState().sessions.find((item) => item.id === sessionId);
    if (!session || session.active || session.status === "starting") return;

    try {
      updateSession(sessionId, {
        active: false,
        status: "starting",
        statusRevision: 0,
        statusUpdatedAt: Date.now(),
      });
      await cleanupSessionProcess(sessionId);
      let agentSessionId = session.agentSessionId;
      if (session.agentId === "codex") {
        agentSessionId ??= await resolveRecentCodexSessionId(session.path, session.createdAt);
        if (!agentSessionId) throw new CodexSessionRestoreError();
      } else if (session.agentId === "pi") {
        // Pi can create or resume an exact UUID with --session-id. Reuse the
        // stable Termflow session ID so restoration never depends on recency.
        agentSessionId ??= sessionId;
      }
      const launchOptions: SessionLaunchOptions | undefined = session.agentId === "antigravity"
        ? {
            dangerouslySkipPermissions: session.antigravityDangerouslySkipPermissions ?? false,
            sandbox: session.antigravitySandbox ?? false,
            mode: session.antigravityMode ?? "inherit",
          }
        : session.agentId === "qoder"
          ? { permissionMode: session.qoderPermissionMode ?? "inherit" }
          : undefined;

      await spawnPty(
        sessionId,
        session.path,
        Boolean(session.hasPromptHistory),
        session.agentId === "claude" || !session.agentId
          ? (session.claudeSkipPermissions ?? false)
          : false,
        getAgentStartupCommand(
          session.agentId,
          session.agentExecutablePath,
          agentSessionId,
          null,
          launchOptions,
          true,
        ),
        undefined,
        isAiAgentId(session.agentId)
          ? getAgentCommandShell(session.agentId)
          : defaultTerminalShell,
        session.agentId === "claude" ? (session.runtimeEffort ?? undefined) : undefined,
        session.agentId,
      );
      updateSession(sessionId, { active: true, status: "waiting", agentSessionId });
    } catch (error) {
      console.error("Failed to resume session:", error);
      updateSession(sessionId, { active: false, status: "error" });
      if (error instanceof CodexSessionRestoreError) {
        message.error({
          key: `codex-session-restore-${sessionId}`,
          title: t("sidebar.codexSessionRestoreFailedTitle"),
          content: t("sidebar.codexSessionRestoreFailedDescription"),
        });
      } else {
        message.error(error instanceof Error ? error.message : String(error));
      }
    }
  }, [defaultTerminalShell, t, updateSession]);
}
