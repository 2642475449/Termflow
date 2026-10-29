import { describe, expect, it } from "vitest";
import { collectTaskMonitorProjects, collectTaskMonitorTabs } from "./taskMonitor";
import type { Session, WindowProjectContext } from "@/types";

const projectWindows: WindowProjectContext[] = [
  { windowLabel: "termflow", mode: "project", projectPath: "E:/Termflow", projectName: "Termflow" },
  { windowLabel: "renmin", mode: "project", projectPath: "E:/renmin", projectName: "renmin" },
  { windowLabel: "phospherus", mode: "project", projectPath: "E:/Phospherus", projectName: "Phospherus" },
];

it("keeps the same project order when switching windows or refreshing window enumeration", () => {
  const expected = ["Phospherus", "renmin", "Termflow"];
  for (const window of projectWindows) {
    const current = { path: window.projectPath!, name: window.projectName! };
    expect(collectTaskMonitorProjects(projectWindows, current).map((project) => project.name)).toEqual(expected);
    expect(collectTaskMonitorProjects([...projectWindows].reverse(), current).map((project) => project.name)).toEqual(expected);
  }
  expect(projectWindows.map((window) => window.windowLabel)).toEqual(["termflow", "renmin", "phospherus"]);
});

it("sorts project names without case priority and breaks name ties by full path", () => {
  const windows: WindowProjectContext[] = [
    { windowLabel: "z", mode: "project", projectPath: "E:/z", projectName: "Beta" },
    { windowLabel: "alpha", mode: "project", projectPath: "E:/alpha", projectName: "alpha" },
    { windowLabel: "a", mode: "project", projectPath: "E:/a", projectName: "beta" },
    { windowLabel: "launcher", mode: "launcher" },
  ];
  expect(collectTaskMonitorProjects(windows, null).map((project) => project.path))
    .toEqual(["E:/alpha", "E:/a", "E:/z"]);
  expect(collectTaskMonitorProjects([...windows].reverse(), null).map((project) => project.path))
    .toEqual(["E:/alpha", "E:/a", "E:/z"]);
});

it("uses shared window metadata and deduplicates alternate current project path spellings", () => {
  expect(collectTaskMonitorProjects(projectWindows, { path: "e:\\RENMIN\\", name: "Local name" }))
    .toEqual(collectTaskMonitorProjects(projectWindows, null));
});

it("includes an unsynced current project in sorted order and removes closed projects", () => {
  const current = { path: "E:/another", name: "Another" };
  expect(collectTaskMonitorProjects(projectWindows, current).map((project) => project.name))
    .toEqual(["Another", "Phospherus", "renmin", "Termflow"]);
  expect(collectTaskMonitorProjects([], current)).toEqual([current]);
  expect(collectTaskMonitorProjects([], null)).toEqual([]);
});

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

  it("keeps tab positions when task statuses change", () => {
    const sessions = [session("a", { status: "running" }), session("b", { status: "waiting" }),
      session("c", { status: "error" })];
    const panes = { main: { id: "main", tabIds: ["b", "c", "a"] } };
    expect(collectTaskMonitorTabs(sessions, panes, {}).map((tab) => tab.id)).toEqual(["b", "c", "a"]);
    const updated = sessions.map((item) => ({ ...item, status: "completed" as const }));
    expect(collectTaskMonitorTabs(updated, panes, {}).map((tab) => tab.id)).toEqual(["b", "c", "a"]);
  });
});
