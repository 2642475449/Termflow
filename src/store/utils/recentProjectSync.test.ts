import { expect, it } from "vitest";
import { mergeRecentProjectRecords, visibleRecentProjects, type RecentProjectRecord } from "./recentProjectSync";

const entry = (path: string, time: number, removed = false): RecentProjectRecord => ({
  project: { path, name: path, lastOpenedAt: time }, revision: time, removed,
});

it("converges independently of snapshot arrival order and Windows path spelling", () => {
  const a = [entry("E:/project/A", 1), entry("E:/project/B", 4)];
  const b = [entry("e:/project/a", 3), entry("E:/project/C", 2)];
  expect(mergeRecentProjectRecords(a, b)).toEqual(mergeRecentProjectRecords(b, a));
  expect(visibleRecentProjects(mergeRecentProjectRecords(a, b)).map((p) => p.lastOpenedAt)).toEqual([4, 3, 2]);
});

it("does not resurrect deleted projects from stale startup snapshots but allows reopening", () => {
  const stale = [entry("E:/project/A", 1)];
  const deleted = mergeRecentProjectRecords(stale, [entry("E:/project/A", 5, true)]);
  expect(visibleRecentProjects(mergeRecentProjectRecords(deleted, stale))).toEqual([]);
  expect(visibleRecentProjects(mergeRecentProjectRecords(deleted, [entry("E:/project/A", 6)]))).toHaveLength(1);
});

it("uses a deterministic order for equal timestamps and limits the visible list", () => {
  const records = Array.from({ length: 12 }, (_, i) => entry("E:/project/" + i, 1));
  expect(visibleRecentProjects(mergeRecentProjectRecords(records))).toEqual(
    visibleRecentProjects(mergeRecentProjectRecords([...records].reverse())),
  );
  expect(visibleRecentProjects(records)).toHaveLength(10);
});
