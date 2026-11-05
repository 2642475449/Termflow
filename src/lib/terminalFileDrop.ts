export interface AgentFileDropEntry {
  path: string;
  kind: "file" | "directory";
  name?: string;
}

export function sanitizePromptPath(path: string): string {
  return path.replace(/[\x00-\x1f\x7f]/g, " ").trim();
}

function normalizePath(path: string): string {
  // Preserve the leading double slash in UNC paths.
  return sanitizePromptPath(path).replace(/\\/g, "/").replace(/\/$/, "");
}

function quoteReference(path: string): string {
  return /[\s"'`$;&|<>()]/.test(path)
    ? `"${path.replace(/"/g, '\\"')}"`
    : path;
}

export function buildAgentFileReferencePrompt({ agentId, projectPath, entries }: {
  agentId: string | undefined;
  projectPath: string;
  entries: AgentFileDropEntry[];
}): string {
  const project = normalizePath(projectPath);
  return entries.filter((entry) => sanitizePromptPath(entry.path)).map((entry) => {
    const original = sanitizePromptPath(entry.path);
    if (agentId === "powershell") return `'${original.replace(/'/g, "''")}'`;
    if (agentId === "cmd") return `"${original.replace(/"/g, '""')}"`;
    const absolute = normalizePath(original);
    const prefix = `${project}/`;
    // Windows drive and UNC paths are case insensitive.
    const windows = /^(?:[a-z]:|\/\/)/i.test(project);
    const inside = windows
      ? absolute.toLowerCase().startsWith(prefix.toLowerCase())
      : absolute.startsWith(prefix);
    const path = absolute === project ? "." : inside ? absolute.slice(prefix.length) : absolute;
    const reference = quoteReference(path);
    if (["claude", "antigravity", "opencode"].includes(agentId ?? "")) return `@${reference}`;
    return entry.kind === "directory" && ["codex", "qoder"].includes(agentId ?? "")
      ? `${reference} (directory)`
      : reference;
  }).join(" ");
}
