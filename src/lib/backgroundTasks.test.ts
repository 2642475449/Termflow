import { describe, expect, it } from "vitest";
import type { GitCloneTask, ProjectSearchIndexStatus } from "@/types";
import { getIndexProgressPercent, summarizeBackgroundTasks } from "./backgroundTasks";

const cloneTask: GitCloneTask = {
  taskId: "clone-1",
  status: "progress",
  projectPath: "E:/projects/demo",
  directoryName: "demo",
  remoteUrl: "https://example.com/demo.git",
  stage: "receiving",
  progressPercent: 40,
  current: 40,
  total: 100,
  transferred: null,
  speed: null,
  detail: null,
  error: null,
};

function indexStatus(
  state: ProjectSearchIndexStatus["state"],
): ProjectSearchIndexStatus {
  return {
    projectPath: "E:/projects/current",
    enabled: true,
    state,
    backend: state === "ready" ? "fts5" : "scan",
    phase: state === "building" ? "writing" : state === "ready" ? "ready" : "waiting_changes",
    processedFiles: 25,
    totalFiles: 100,
    indexedFiles: 24,
    skippedFiles: 1,
    processedBytes: 250,
    totalBytes: 1000,
    indexSizeBytes: 0,
    startedAt: 1,
    updatedAt: 2,
    error: null,
  };
}

describe("background task summary", () => {
  it("keeps clone and index work as two concurrent tasks", () => {
    expect(summarizeBackgroundTasks([cloneTask], indexStatus("building"), null)).toEqual({
      cloneCount: 1,
      indexVisible: true,
      totalCount: 2,
      concurrent: true,
      indexProgressPercent: 25,
    });
  });

  it("counts multiple clones independently from the index task", () => {
    const secondClone = { ...cloneTask, taskId: "clone-2" };
    expect(summarizeBackgroundTasks([cloneTask, secondClone], indexStatus("stale"), null).totalCount)
      .toBe(3);
  });

  it("hides ready indexes but keeps failures visible", () => {
    expect(summarizeBackgroundTasks([], indexStatus("ready"), null).totalCount).toBe(0);
    expect(summarizeBackgroundTasks([], null, "listener failed").indexVisible).toBe(true);
  });

  it("clamps index progress", () => {
    expect(getIndexProgressPercent({ ...indexStatus("building"), processedFiles: 120 })).toBe(100);
    expect(getIndexProgressPercent({ ...indexStatus("preflight"), totalFiles: null })).toBeNull();
  });
});
