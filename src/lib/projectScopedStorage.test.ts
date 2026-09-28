import { describe, expect, it } from "vitest";
import { mergeProjectScopedPersistedState } from "./projectScopedStorage";

const pathA = "E:/projects/a";
const pathB = "E:/projects/b";

function snapshot(
  writer: string | null,
  sessions: Record<string, unknown[]>,
  archived: Record<string, unknown[]> = {},
) {
  return JSON.stringify({
    version: 3,
    state: {
      __writerProjectPath: writer,
      projectSessions: sessions,
      projectArchivedSessions: archived,
      projectWorkspaces: {},
      projectAttentionItems: {},
    },
  });
}

describe("project scoped persistence", () => {
  it("preserves new sessions when a stale launcher or voice window writes", () => {
    const current = snapshot(pathA, { [pathA]: [{ id: "new" }] });
    const stale = snapshot(null, { [pathA]: [] });
    const merged = JSON.parse(mergeProjectScopedPersistedState(current, stale));
    expect(merged.state.projectSessions[pathA]).toEqual([{ id: "new" }]);
    expect(merged.state).not.toHaveProperty("__writerProjectPath");
  });

  it("updates only the writing project's sessions and archived sessions", () => {
    const current = snapshot(pathA, {
      [pathA]: [{ id: "a" }],
      [pathB]: [{ id: "b" }],
    });
    const next = snapshot(pathB, {
      [pathA]: [],
      [pathB]: [],
    }, { [pathB]: [{ id: "b" }] });
    const merged = JSON.parse(mergeProjectScopedPersistedState(current, next));
    expect(merged.state.projectSessions[pathA]).toEqual([{ id: "a" }]);
    expect(merged.state.projectSessions[pathB]).toEqual([]);
    expect(merged.state.projectArchivedSessions[pathB]).toEqual([{ id: "b" }]);
  });

  it("keeps another project's workspace and attention state", () => {
    const current = JSON.parse(snapshot(pathA, { [pathA]: [] }));
    current.state.projectWorkspaces[pathA] = { marker: "workspace-a" };
    current.state.projectAttentionItems[pathA] = [{ id: "attention-a" }];
    const next = snapshot(pathB, { [pathB]: [] });
    const merged = JSON.parse(mergeProjectScopedPersistedState(JSON.stringify(current), next));
    expect(merged.state.projectWorkspaces[pathA]).toEqual({ marker: "workspace-a" });
    expect(merged.state.projectAttentionItems[pathA]).toEqual([{ id: "attention-a" }]);
  });
});
