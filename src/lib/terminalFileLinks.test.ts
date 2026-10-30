import { expect, it, vi } from "vitest";
import { assertTerminalLinkProject, createTerminalFileLinkResolver, createTerminalLinkActivationGate, getUnambiguousTerminalTarget, openTerminalFileTarget } from "./terminalFileLinks";
import type { TerminalLinkTarget } from "./api/terminalLinks";

const context = { projectPath: "E:/project", workingDirectory: "E:/project/src" };
const target: TerminalLinkTarget = { path: "E:/project/example.custom", kind: "file", inProject: true };
const resolution = { targets: [target], truncated: false };

it("preserves dragging and double-click selection while keeping deliberate direct clicks immediate", () => {
  vi.useFakeTimers();
  try {
    let selected = false;
    const gate = createTerminalLinkActivationGate(() => selected);
    const open = vi.fn();
    gate.activate(open);
    expect(open).not.toHaveBeenCalled();
    selected = true;
    gate.activate(open);
    vi.runAllTimers();
    expect(open).not.toHaveBeenCalled();
    gate.activate(open, true);
    expect(open).not.toHaveBeenCalled();
    selected = false;
    gate.activate(open);
    gate.activate(open, true);
    expect(open).toHaveBeenCalledTimes(1);
    vi.runAllTimers();
    expect(open).toHaveBeenCalledTimes(1);
    gate.activate(open);
    vi.runAllTimers();
    expect(open).toHaveBeenCalledTimes(2);
    gate.activate(open);
    gate.dispose();
    vi.runAllTimers();
    expect(open).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it("deduplicates hover lookups but revalidates actual clicks and changed working directories", async () => {
  let time = 0;
  const backend = vi.fn().mockResolvedValue(resolution);
  const resolve = createTerminalFileLinkResolver(backend, () => time);
  await Promise.all([resolve(context, "example.custom"), resolve(context, "example.custom")]);
  expect(backend).toHaveBeenCalledTimes(1);
  await resolve(context, "example.custom", true);
  await resolve({ ...context, workingDirectory: "E:/project/other" }, "example.custom");
  expect(backend).toHaveBeenCalledTimes(3);
  time = 5_001;
  await resolve(context, "example.custom");
  expect(backend).toHaveBeenCalledTimes(4);
});

it("does not retain failed validation and never chooses ambiguous or incomplete search results", async () => {
  const backend = vi.fn().mockRejectedValueOnce(new Error("temporary failure")).mockResolvedValue(resolution);
  const resolve = createTerminalFileLinkResolver(backend);
  await expect(resolve(context, "example.custom")).rejects.toThrow("temporary failure");
  await expect(resolve(context, "example.custom")).resolves.toEqual(resolution);
  expect(getUnambiguousTerminalTarget(resolution)).toBe(target);
  expect(getUnambiguousTerminalTarget({ targets: [], truncated: false })).toBeNull();
  expect(getUnambiguousTerminalTarget({ targets: [target, { ...target, path: "E:/project/other/example.custom" }], truncated: false })).toBeNull();
  expect(getUnambiguousTerminalTarget({ targets: [target], truncated: true })).toBeNull();
});

function actions(kind: "text" | "image" | "pdf" | "binary" = "text") {
  return {
    inspect: vi.fn().mockResolvedValue({ kind }),
    openSystem: vi.fn().mockResolvedValue(undefined),
    openPreview: vi.fn(), openEditor: vi.fn(),
  };
}

it.each(["song.MP3", "movie.webm", "backup.tar.gz", "archive.7z"])("opens %s with the system application without reading it as text", async (file) => {
  const calls = actions();
  await openTerminalFileTarget({ ...target, path: `E:/project/${file}` }, context, {}, calls);
  expect(calls.openSystem).toHaveBeenCalledExactlyOnceWith(`E:/project/${file}`);
  expect(calls.inspect).not.toHaveBeenCalled();
});

it("uses content detection for unknown binary formats and retains existing Office previews", async () => {
  const calls = actions("binary");
  await openTerminalFileTarget(target, context, {}, calls);
  expect(calls.openSystem).toHaveBeenCalledExactlyOnceWith(target.path);
  await openTerminalFileTarget({ ...target, path: "E:/project/report.docx" }, context, {}, calls);
  expect(calls.openEditor).toHaveBeenCalledExactlyOnceWith("E:/project/report.docx", undefined);
});

it("opens outside-project files and directories through the system without using project read APIs", async () => {
  const calls = actions();
  await openTerminalFileTarget({ ...target, inProject: false }, context, {}, calls);
  await openTerminalFileTarget({ ...target, kind: "directory", inProject: false }, context, {}, calls);
  expect(calls.openSystem).toHaveBeenCalledTimes(2);
  expect(calls.inspect).not.toHaveBeenCalled();
});

it("opens directories in the system file manager and sends line and column references to the editor", async () => {
  const calls = actions();
  await openTerminalFileTarget({ ...target, kind: "directory" }, context, {}, calls);
  expect(calls.openSystem).toHaveBeenCalledExactlyOnceWith(target.path);
  await openTerminalFileTarget(target, context, { line: 12, column: 7 }, calls);
  expect(calls.openEditor).toHaveBeenCalledExactlyOnceWith(target.path, { line: 12, column: 7 });
});

it("keeps the workspace root spelling and junction alias when editing canonical targets", async () => {
  const calls = actions();
  const aliasContext = { ...context, projectPath: "e:\\AliasProject" };
  await openTerminalFileTarget({ ...target, projectRelativePath: "src/example.custom" }, aliasContext, {}, calls);
  expect(calls.inspect).toHaveBeenCalledExactlyOnceWith(aliasContext.projectPath, "e:\\AliasProject\\src\\example.custom");
  expect(calls.openEditor).toHaveBeenCalledExactlyOnceWith("e:\\AliasProject\\src\\example.custom", undefined);
});

it("does not open a delayed result in a different project workspace", async () => {
  let currentProjectPath: string | undefined = context.projectPath;
  const calls = actions();
  calls.inspect.mockImplementationOnce(async () => {
    currentProjectPath = "E:/other";
    return { kind: "text" };
  });
  calls.openEditor.mockImplementation(() => assertTerminalLinkProject(context, currentProjectPath));
  await expect(openTerminalFileTarget(target, context, {}, calls)).rejects.toThrow("terminal.linkContextChanged");
  expect(() => assertTerminalLinkProject(context, undefined)).toThrow("terminal.linkContextChanged");
  expect(() => assertTerminalLinkProject(context, context.projectPath)).not.toThrow();
});

it("keeps PDF and Markdown preview behavior while honoring Markdown source locations", async () => {
  const markdown = { ...target, path: "E:/project/readme.md" };
  const calls = actions();
  await openTerminalFileTarget(markdown, context, {}, calls);
  await openTerminalFileTarget(markdown, context, { line: 5 }, calls);
  expect(calls.openPreview).toHaveBeenCalledExactlyOnceWith(markdown.path);
  expect(calls.openEditor).toHaveBeenCalledExactlyOnceWith(markdown.path, { line: 5, column: 1 });
  const pdfCalls = actions("pdf");
  await openTerminalFileTarget({ ...target, path: "E:/project/report.pdf" }, context, {}, pdfCalls);
  expect(pdfCalls.openPreview).toHaveBeenCalledExactlyOnceWith("E:/project/report.pdf");
});

it("propagates system opening and inspection failures to the visible UI error handler", async () => {
  const calls = actions("binary");
  calls.openSystem.mockRejectedValueOnce(new Error("no associated application"));
  await expect(openTerminalFileTarget(target, context, {}, calls)).rejects.toThrow("no associated application");
  calls.inspect.mockRejectedValueOnce(new Error("file disappeared"));
  await expect(openTerminalFileTarget(target, context, {}, calls)).rejects.toThrow("file disappeared");
});
