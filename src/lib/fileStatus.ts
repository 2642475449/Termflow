export function getStatusBarFilePath(path: string, projectPath?: string | null): string {
  const normalized = path.replace(/\\/g, "/");
  const root = projectPath?.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!root) return normalized;
  const windowsPath = /^[a-z]:\//i.test(normalized) || normalized.startsWith("//");
  const comparable = windowsPath ? normalized.toLowerCase() : normalized;
  const prefix = `${windowsPath ? root.toLowerCase() : root}/`;
  return comparable.startsWith(prefix) ? normalized.slice(root.length + 1) : normalized;
}

export interface StatusPathSegment {
  label: string;
  path: string;
  kind: "directory" | "file";
}

export function getStatusPathSegments(path: string, projectPath?: string | null): StatusPathSegment[] {
  const normalized = path.replace(/\\/g, "/");
  const relative = getStatusBarFilePath(path, projectPath);
  const root = projectPath?.replace(/\\/g, "/").replace(/\/+$/, "");
  const insideProject = Boolean(root && relative !== normalized);
  const segments: StatusPathSegment[] = [];
  let parent = insideProject ? root! : normalized.startsWith("//") ? "//" : "";
  if (insideProject) {
    segments.push({ label: root!.split("/").pop() || root!, path: root!, kind: "directory" });
  }
  const parts = relative.split("/").filter(Boolean);
  for (const [index, label] of parts.entries()) {
    parent = parent ? `${parent.replace(/\/$/, "")}/${label}`
      : normalized.startsWith("/") && !insideProject ? `/${label}` : label;
    if (/^[a-z]:$/i.test(parent)) parent += "/";
    segments.push({ label, path: parent, kind: index === parts.length - 1 ? "file" : "directory" });
  }
  return segments;
}
