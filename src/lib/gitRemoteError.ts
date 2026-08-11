import { stripAnsiEscapeSequences } from "./textContent";

export type GitRemoteErrorKind =
  | "networkInterrupted"
  | "authenticationFailed"
  | "repositoryNotFound"
  | "timeout"
  | "generic";

export interface GitRemoteErrorSummary {
  kind: GitRemoteErrorKind;
  detail: string;
}

const GIT_PROGRESS_LINE = /^(?:remote:\s*)?(?:enumerating objects|counting objects|compressing objects|receiving objects|resolving deltas|total\s)/i;
function truncateDetail(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function summarizeGitRemoteError(
  rawMessage: string,
  maxLength = 180,
): GitRemoteErrorSummary {
  const normalized = stripAnsiEscapeSequences(rawMessage).replace(/\r/g, "\n").trim();
  const lower = normalized.toLowerCase();

  let kind: GitRemoteErrorKind = "generic";
  if (
    /authentication failed|could not read username|permission denied \(publickey\)|http (?:401|403)/i.test(normalized)
  ) {
    kind = "authenticationFailed";
  } else if (
    /repository(?: .*?)? not found|does not appear to be a git repository/i.test(normalized)
  ) {
    kind = "repositoryNotFound";
  } else if (/timed out|operation timeout|operation too slow/i.test(normalized)) {
    kind = "timeout";
  } else if (
    /curl\s+(?:18|35|52|55|56)|early eof|unexpected disconnect|connection (?:reset|closed|aborted)|schannel|tls|ssl/i.test(lower)
  ) {
    kind = "networkInterrupted";
  }

  const uniqueLines = Array.from(
    new Set(
      normalized
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !GIT_PROGRESS_LINE.test(line)),
    ),
  );
  const importantLines = uniqueLines.filter((line) => /^(?:fatal|error):/i.test(line));
  const detailSource = (importantLines.length > 0 ? importantLines.slice(-2) : uniqueLines.slice(-1))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    kind,
    detail: truncateDetail(detailSource || "Git operation failed", Math.max(24, maxLength)),
  };
}
