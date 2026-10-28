import type { Session } from "@/types";

type CodexUsageSession = Pick<Session, "active" | "agentId">;

export function shouldLoadCodexRateLimits(
  activeSession: CodexUsageSession | null,
): boolean {
  return activeSession?.active === true && activeSession.agentId === "codex";
}

export function shouldLoadClaudeRateLimits(
  activeSession: CodexUsageSession | null,
): boolean {
  return activeSession?.active === true && activeSession.agentId === "claude";
}

export function shouldLoadQoderUsage(
  activeSession: CodexUsageSession | null,
): boolean {
  return activeSession?.active === true && activeSession.agentId === "qoder";
}

