interface ClipboardSessionSnapshot {
  sessions: readonly { id: string }[];
  projectSessions: Record<string, readonly { id: string }[]>;
  projectArchivedSessions: Record<string, readonly { id: string }[]>;
}

/** 合并全部已知项目和归档，切换项目或关闭标签不会被当作永久删除。 */
export function collectClipboardSessionIds(snapshot: ClipboardSessionSnapshot): string[] {
  return [...new Set([
    ...snapshot.sessions,
    ...Object.values(snapshot.projectSessions).flat(),
    ...Object.values(snapshot.projectArchivedSessions).flat(),
  ].map((session) => session.id))].sort();
}

export function removedClipboardSessionIds(previous: readonly string[], next: readonly string[]): string[] {
  const present = new Set(next);
  return previous.filter((id) => !present.has(id));
}
