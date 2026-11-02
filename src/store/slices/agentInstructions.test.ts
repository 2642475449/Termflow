import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import type { ProjectFileContent } from "@/types";
import { loadAgentInstructionFile, saveAgentInstructionFile, useAgentInstructionsStore } from "./agentInstructions";

const projectPath = "E:\\7.project\\test\\Termflow";
const filePath = `${projectPath}\\AGENTS.md`;

function file(path: string, content = "# 项目协作规范"): ProjectFileContent {
  return {
    path, name: path.split(/[\\/]/).pop() ?? path, content, kind: "text", encoding: "utf-8",
    readOnly: false, sizeBytes: content.length, largeFile: false,
  };
}

beforeEach(() => useAgentInstructionsStore.setState(useAgentInstructionsStore.getInitialState(), true));
afterEach(() => vi.restoreAllMocks());

it.each(["AGENTS.md", "AGENTS.local.md", "GEMINI.md"])("reads %s using its full project path", async (name) => {
  const path = `${projectPath}\\${name}`;
  const read = vi.spyOn(api, "readProjectFile").mockImplementation(async (root, target) => {
    // 对齐后端契约：项目外的路径（包括裸文件名）会被拒绝。
    if (root !== projectPath || !target.startsWith(`${root}\\`)) throw "不允许访问项目目录之外的路径";
    return file(target);
  });
  await loadAgentInstructionFile(projectPath, path);
  expect(read).toHaveBeenCalledWith(projectPath, path);
  expect(useAgentInstructionsStore.getState().documents[path]).toMatchObject({
    exists: true, loaded: true, loading: false, content: "# 项目协作规范", draft: "# 项目协作规范", error: null,
  });
});

it("only treats the backend's explicit missing-file error as a new file", async () => {
  vi.spyOn(api, "readProjectFile").mockRejectedValue("目标路径不存在");
  await loadAgentInstructionFile(projectPath, filePath);
  expect(useAgentInstructionsStore.getState().documents[filePath]).toMatchObject({
    exists: false, loaded: true, loading: false, draft: "", error: null,
  });
});

it.each(["不允许访问项目目录之外的路径", "项目目录不存在", "读取文件失败: Access is denied"])(
  "keeps a read error visible and prevents saving: %s", async (error) => {
    const read = vi.spyOn(api, "readProjectFile").mockRejectedValue(error);
    const create = vi.spyOn(api, "createProjectFile");
    const write = vi.spyOn(api, "writeProjectFile");
    await loadAgentInstructionFile(projectPath, filePath);
    expect(useAgentInstructionsStore.getState().documents[filePath]).toMatchObject({
      exists: null, loaded: true, loading: false, error,
    });
    // 普通重渲染不会反复请求；用户可以通过刷新明确重试。
    await loadAgentInstructionFile(projectPath, filePath);
    expect(read).toHaveBeenCalledTimes(1);
    expect(await saveAgentInstructionFile(projectPath, filePath)).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  },
);

it("retries a failed read on refresh and preserves the draft if refresh also fails", async () => {
  const read = vi.spyOn(api, "readProjectFile").mockRejectedValueOnce("permission denied").mockResolvedValueOnce(file(filePath));
  await loadAgentInstructionFile(projectPath, filePath);
  await loadAgentInstructionFile(projectPath, filePath, true);
  useAgentInstructionsStore.getState().setDraft(filePath, "unsaved changes");
  read.mockRejectedValueOnce(new Error("refresh failed"));
  await loadAgentInstructionFile(projectPath, filePath, true);
  expect(useAgentInstructionsStore.getState().documents[filePath]).toMatchObject({
    exists: true, content: "# 项目协作规范", draft: "unsaved changes", error: "refresh failed",
  });
});

it("isolates same-named files across projects, including late responses", async () => {
  let resolveFirst!: (value: ProjectFileContent) => void;
  const otherRoot = "E:/Other";
  const otherPath = `${otherRoot}/AGENTS.md`;
  vi.spyOn(api, "readProjectFile").mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
    .mockResolvedValueOnce(file(otherPath, "Other project"));
  const first = loadAgentInstructionFile(projectPath, filePath);
  await loadAgentInstructionFile(otherRoot, otherPath);
  resolveFirst(file(filePath, "First project"));
  await first;
  expect(useAgentInstructionsStore.getState().documents[filePath].content).toBe("First project");
  expect(useAgentInstructionsStore.getState().documents[otherPath].content).toBe("Other project");
});

it("saves an existing file at its full path and preserves its encoding and newer edits", async () => {
  vi.spyOn(api, "readProjectFile").mockResolvedValue({ ...file(filePath), encoding: "utf-8-bom" });
  const create = vi.spyOn(api, "createProjectFile");
  let finishSave!: () => void;
  const write = vi.spyOn(api, "writeProjectFile").mockImplementation(() => new Promise((resolve) => { finishSave = resolve; }));
  await loadAgentInstructionFile(projectPath, filePath);
  useAgentInstructionsStore.getState().setDraft(filePath, "Saved draft");
  const pending = saveAgentInstructionFile(projectPath, filePath);
  useAgentInstructionsStore.getState().setDraft(filePath, "Newer draft");
  finishSave();
  expect(await pending).toBe(true);
  expect(create).not.toHaveBeenCalled();
  expect(write).toHaveBeenCalledWith(projectPath, filePath, "Saved draft", "utf-8-bom");
  expect(useAgentInstructionsStore.getState().documents[filePath]).toMatchObject({
    exists: true, content: "Saved draft", draft: "Newer draft", saving: false,
  });
});

it("creates a confirmed missing file and writes to the same full path", async () => {
  vi.spyOn(api, "readProjectFile").mockRejectedValue("目标路径不存在");
  const create = vi.spyOn(api, "createProjectFile").mockResolvedValue(filePath);
  const write = vi.spyOn(api, "writeProjectFile").mockResolvedValue();
  await loadAgentInstructionFile(projectPath, filePath);
  useAgentInstructionsStore.getState().setDraft(filePath, "New instructions");
  expect(await saveAgentInstructionFile(projectPath, filePath)).toBe(true);
  expect(create).toHaveBeenCalledWith(projectPath, projectPath, "AGENTS.md");
  expect(write).toHaveBeenCalledWith(projectPath, filePath, "New instructions", undefined);
});

it("preserves unsaved content and clears saving when a write fails", async () => {
  vi.spyOn(api, "readProjectFile").mockResolvedValue(file(filePath));
  vi.spyOn(api, "writeProjectFile").mockRejectedValue("read-only file");
  await loadAgentInstructionFile(projectPath, filePath);
  useAgentInstructionsStore.getState().setDraft(filePath, "Unsaved draft");
  await expect(saveAgentInstructionFile(projectPath, filePath)).rejects.toBe("read-only file");
  expect(useAgentInstructionsStore.getState().documents[filePath]).toMatchObject({
    content: "# 项目协作规范", draft: "Unsaved draft", saving: false,
  });
});
