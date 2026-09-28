import type { StateStorage } from "zustand/middleware";

const PROJECT_FIELDS = [
  "projectSessions",
  "projectArchivedSessions",
  "projectWorkspaces",
  "projectAttentionItems",
] as const;

type PersistedEnvelope = {
  state: Record<string, unknown> & { __writerProjectPath?: string | null };
  version?: number;
};

function isEnvelope(value: unknown): value is PersistedEnvelope {
  return value !== null && typeof value === "object" &&
    "state" in value && value.state !== null && typeof value.state === "object";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 每个窗口只写自己项目的数据，避免其他窗口的旧快照覆盖新会话。 */
export function mergeProjectScopedPersistedState(
  currentValue: string | null,
  nextValue: string,
): string {
  const next: unknown = JSON.parse(nextValue);
  if (!isEnvelope(next)) return nextValue;

  const projectPath = next.state.__writerProjectPath;
  delete next.state.__writerProjectPath;

  if (!currentValue) return JSON.stringify(next);
  let current: unknown;
  try {
    current = JSON.parse(currentValue);
  } catch {
    return JSON.stringify(next);
  }
  if (!isEnvelope(current)) return JSON.stringify(next);

  for (const field of PROJECT_FIELDS) {
    const existing = isRecord(current.state[field]) ? current.state[field] : {};
    const incoming = isRecord(next.state[field]) ? next.state[field] : {};
    next.state[field] = projectPath
      ? { ...existing, [projectPath]: incoming[projectPath] ?? existing[projectPath] ?? [] }
      : existing;
  }
  return JSON.stringify(next);
}

export function createProjectScopedStorage(storage: StateStorage): StateStorage {
  return {
    getItem: (name) => storage.getItem(name),
    removeItem: (name) => storage.removeItem(name),
    setItem: (name, value) => {
      const current = storage.getItem(name);
      if (current instanceof Promise) {
        return current.then((resolved) => storage.setItem(
          name, mergeProjectScopedPersistedState(resolved, value),
        ));
      }
      return storage.setItem(name, mergeProjectScopedPersistedState(current, value));
    },
  };
}
