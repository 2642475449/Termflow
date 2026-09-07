import { describe, expect, it } from "vitest";
import { collectTaskMonitorTabs } from "./taskMonitor";
import type { Session } from "@/types";

const session = (id: string, extra: Partial<Session> = {}): Session => ({
  id, name: id, path: "/project", createdAt: 1, active: true, agentId: "codex", ...extra,
});

describe("task monitor tabs", () => {
  it("lists only open AI tabs in pane order and preserves displayed titles", () => {
    const result = collectTaskMonitorTabs([
      session("a"), session("b"), session("closed"),
      session("shell", { agentId: "cmd" }), session("archived", { archived: true }),
    ], { main: { id: "main", tabIds: ["b", "file", "shell", "archived", "a"] },
      right: { id: "right", tabIds: ["a"] } }, { b: { title: "Renamed task" } });
    expect(result.map((tab) => [tab.id, tab.name, tab.paneId])).toEqual([
      ["b", "Renamed task", "main"], ["a", "a", "main"],
    ]);
  });

  it("does not mistake a live terminal for a running turn", () => {
    const sessions = [session("waiting", { status: "waiting" }),
      session("done", { status: "completed", active: false }),
      session("stale", { status: "running", active: false }),
      session("error", { status: "error", active: false }), session("idle")];
    const result = collectTaskMonitorTabs(sessions,
      { main: { id: "main", tabIds: sessions.map((item) => item.id) } }, {});
    expect(result.map((tab) => tab.status)).toEqual(["waiting", "completed", "idle", "error", "idle"]);
  });
});
