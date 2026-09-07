import type { WindowProjectContext } from "@/types";
import type { ProjectInfo } from "@/store/utils/recentProjects";

export function projectPathKey(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase() : normalized;
}

export function collectOpenProjects(contexts: WindowProjectContext[], current: ProjectInfo | null): ProjectInfo[] {
  const projects = new Map<string, ProjectInfo>();
  if (current) projects.set(projectPathKey(current.path), current);
  for (const context of contexts) {
    if (context.mode !== "project" || !context.projectPath) continue;
    const path = context.projectPath;
    const key = projectPathKey(path);
    if (!projects.has(key)) projects.set(key, {
      path,
      name: context.projectName || path.split(/[\\/]/).filter(Boolean).pop() || path,
    });
  }
  return [...projects.values()];
}
