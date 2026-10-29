import { beforeEach, expect, it } from "vitest";
import type { BottomRunnerTab } from "../types";
import { clampBottomRunnerHeight, runnerExitStatus, useBottomRunnerStore } from "./bottomRunner";

const state = () => useBottomRunnerStore.getState();
function tab(id: string, projectPath = "A", status: BottomRunnerTab["status"] = "running"): BottomRunnerTab {
  return { id, sessionId: id, commandId: id, commandLabel: id, commandText: "echo hi", shell: "powershell",
    projectPath, status, exitCode: null, startTime: 1, endTime: null };
}
beforeEach(() => {
  state().reset();
  state().setHeight(260);
  state().setAutoScroll(true);
  state().setWordWrap(false);
});
it("clamps height to viewport margin and protects small viewports including invalid heights", () => {
  expect(clampBottomRunnerHeight(500, 349)).toBe(0);
  expect(clampBottomRunnerHeight(NaN, 300)).toBe(0);
  expect(clampBottomRunnerHeight(500, 350)).toBe(130);
  expect(clampBottomRunnerHeight(500, 600)).toBe(380);
  expect(clampBottomRunnerHeight(-5, 900)).toBe(120);
  expect(clampBottomRunnerHeight(9999, 1100)).toBe(650);
  expect(clampBottomRunnerHeight(NaN, 800)).toBe(260);
  expect(clampBottomRunnerHeight(260.7, 800)).toBe(261);
});
it("collapses for a small viewport without overwriting the preferred height", () => {
  state().setOpen(true);
  state().setHeight(500, 300);
  expect(state()).toMatchObject({ height: 260, open: false });
  state().toggleOpen();
  expect(state().open).toBe(true);
});
it("recycles the earliest finished tab before any live task at the eight tab cap", () => {
  for (let i = 0; i < 8; i++) state().addRunTab("A", tab(String(i), "A", i === 2 || i === 5 ? "completed" : "running"));
  expect(state().addRunTab("A", tab("8"))?.id).toBe("2");
  expect(state().tabsByProject.A.map((item) => item.id)).toEqual(["0", "1", "3", "4", "5", "6", "7", "8"]);
  expect(state().activeTabIdByProject.A).toBe("8");
});
it("returns the oldest live task for cleanup when all eight slots are busy", () => {
  for (let i = 0; i < 8; i++) state().addRunTab("A", tab(String(i)));
  expect(state().addRunTab("A", tab("8"))?.id).toBe("0");
  expect(state().tabsByProject.A).toHaveLength(8);
});
it("updates an existing tab without consuming another slot", () => {
  state().addRunTab("A", tab("a"));
  expect(state().addRunTab("A", { ...tab("a"), commandLabel: "changed" })).toBeNull();
  expect(state().tabsByProject.A).toHaveLength(1);
  expect(state().tabsByProject.A[0].commandLabel).toBe("changed");
});
it("isolates projects and preserves each active tab on project changes", () => {
  state().addRunTab("A", tab("a"));
  state().addRunTab("B", tab("b", "B"));
  state().handleProjectChange("empty");
  expect(state().open).toBe(false);
  state().handleProjectChange("A");
  expect(state().tabsByProject.A[0].id).toBe("a");
  state().activateTab("A", "a");
  expect(state().activeTabIdByProject).toEqual({ A: "a", B: "b" });
  state().activateTab("A", "b");
  expect(state().activeTabIdByProject.A).toBe("a");
});
it("records terminal states and end times, and resets codes on a new run", () => {
  state().addRunTab("A", tab("a"));
  state().updateTabStatus("A", "a", "error", 7);
  const end = state().tabsByProject.A[0].endTime;
  expect(end).toBeTypeOf("number");
  state().updateTabStatus("A", "a", "error");
  expect(state().tabsByProject.A[0]).toMatchObject({ exitCode: 7, endTime: end });
  state().updateTabStatus("A", "a", "running", null);
  expect(state().tabsByProject.A[0]).toMatchObject({ exitCode: null, endTime: null });
  expect([null, 0, 1, -1].map(runnerExitStatus)).toEqual(["completed", "success", "error", "error"]);
});
it("closes the active tab using its nearest neighbor and collapses the last tab", () => {
  for (const id of ["a", "b", "c"]) state().addRunTab("A", tab(id));
  state().activateTab("A", "b");
  state().closeTab("A", "b");
  expect(state().activeTabIdByProject.A).toBe("c");
  state().closeTab("A", "a");
  expect(state().activeTabIdByProject.A).toBe("c");
  state().closeTab("A", "c");
  expect(state()).toMatchObject({ open: false, activeTabIdByProject: { A: null } });
});
it("clears only finished tabs in the chosen project", () => {
  state().addRunTab("A", tab("a", "A", "completed"));
  state().addRunTab("A", tab("b", "A", "starting"));
  state().addRunTab("B", tab("c", "B", "error"));
  state().clearFinishedTabs("A");
  expect(state().tabsByProject.A.map((item) => item.id)).toEqual(["b"]);
  expect(state().tabsByProject.B).toHaveLength(1);
});
it("persists only validated UI preferences, never tabs, open state or maximization", async () => {
  const entries = new Map<string, string>();
  useBottomRunnerStore.persist.setOptions({ storage: {
    getItem: (key) => JSON.parse(entries.get(key) ?? "null"),
    setItem: (key, value) => { entries.set(key, JSON.stringify(value)); },
    removeItem: (key) => { entries.delete(key); },
  } });
  state().setHeight(400, 1000);
  state().setWordWrap(true);
  state().addRunTab("A", tab("a"));
  expect(JSON.parse([...entries.values()][0]).state).toEqual({ height: 400, wordWrap: true });
  state().reset();
  await useBottomRunnerStore.persist.rehydrate();
  expect(state()).toMatchObject({ height: 400, wordWrap: true, open: false, tabsByProject: {} });
  const merge = useBottomRunnerStore.persist.getOptions().merge!;
  expect(merge({ height: "oops", autoScroll: "yes", wordWrap: 1, tabsByProject: { A: [tab("x")] }, open: true }, state()))
    .toMatchObject({ height: 260, autoScroll: true, wordWrap: false, open: false, tabsByProject: {} });
});
it("enables auto scroll for a new run and ignores a previously saved pause", () => {
  state().setAutoScroll(false);
  state().addRunTab("A", tab("new"));
  expect(state().autoScroll).toBe(true);
  state().toggleAutoScroll();
  expect(state().autoScroll).toBe(false);
  const merge = useBottomRunnerStore.persist.getOptions().merge!;
  expect(merge({ autoScroll: false }, state()).autoScroll).toBe(true);
});
