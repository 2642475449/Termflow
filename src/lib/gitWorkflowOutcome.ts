import type { GitWorkflowResult } from "@/lib/api";

export function getGitWorkflowOutcome(
  result: GitWorkflowResult,
): "success" | "partial" | "failed" {
  if (result.success) return "success";
  return result.commitOid ? "partial" : "failed";
}
