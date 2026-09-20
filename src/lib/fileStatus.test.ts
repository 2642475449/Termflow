import { expect, it } from "vitest";
import { getStatusPathSegments, getStatusBarFilePath } from "./fileStatus";

it("shows project-relative paths across Windows separators and casing", () => {
  expect(getStatusBarFilePath("E:\\Work\\App\\src\\main.ts", "e:/work/app/")).toBe("src/main.ts");
});

it("does not mistake a sibling directory for the project root", () => {
  expect(getStatusBarFilePath("/work/app-other/a.ts", "/work/app")).toBe("/work/app-other/a.ts");
});

it("keeps case-sensitive paths outside the project intact", () => {
  expect(getStatusBarFilePath("/work/App/a.ts", "/work/app")).toBe("/work/App/a.ts");
  expect(getStatusBarFilePath("/work/a.ts")).toBe("/work/a.ts");
});

it("keeps every breadcrumb and resolves each directory to its complete path", () => {
  const segments = getStatusPathSegments("E:/project/module/src/main/java/CloudConstant.java", "e:/project");
  expect(segments.map((segment) => segment.label)).toEqual(["project", "module", "src", "main", "java", "CloudConstant.java"]);
  expect(segments.find((segment) => segment.label === "src")).toEqual({ label: "src", path: "e:/project/module/src", kind: "directory" });
  expect(segments[segments.length - 1]).toEqual({ label: "CloudConstant.java", path: "e:/project/module/src/main/java/CloudConstant.java", kind: "file" });
});

it("preserves absolute targets outside the project", () => {
  expect(getStatusPathSegments("/external/src/a.ts", "/project").map((segment) => segment.path))
    .toEqual(["/external", "/external/src", "/external/src/a.ts"]);
  const uncSegments = getStatusPathSegments("//server/share/src/a.ts");
  expect(uncSegments[uncSegments.length - 1]?.path).toBe("//server/share/src/a.ts");
});
