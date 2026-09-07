import { expect, it } from "vitest";
import { collectOpenProjects, projectPathKey } from "./openProjects";

it("shows projects from both windows with the current project first", () => {
  expect(collectOpenProjects([
    { windowLabel: "a", mode: "project", projectPath: "E:/orca", projectName: "orca" },
    { windowLabel: "b", mode: "project", projectPath: "E:/CzwChat", projectName: "CzwChat" },
    { windowLabel: "main", mode: "launcher" },
  ], { path: "E:/CzwChat", name: "CzwChat" })).toEqual([
    { path: "E:/CzwChat", name: "CzwChat" }, { path: "E:/orca", name: "orca" },
  ]);
});

it("deduplicates Windows path spelling while preserving case-sensitive Unix paths", () => {
  expect(projectPathKey("E:\\Project\\")).toBe(projectPathKey("e:/project"));
  expect(projectPathKey("/Project")).not.toBe(projectPathKey("/project"));
  expect(collectOpenProjects([
    { windowLabel: "a", mode: "project", projectPath: "e:/PROJECT/" },
  ], { path: "E:\\Project", name: "Project" })).toHaveLength(1);
});

it("supports launcher windows and removes closed projects on a fresh snapshot", () => {
  expect(collectOpenProjects([{ windowLabel: "a", mode: "project", projectPath: "/tmp/demo" }], null))
    .toEqual([{ path: "/tmp/demo", name: "demo" }]);
  expect(collectOpenProjects([], null)).toEqual([]);
});
