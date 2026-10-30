import { expect, it, vi } from "vitest";
import { resolveTerminalLink } from "./terminalLinks";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

it("passes original path and directory context to the dedicated terminal resolver", async () => {
  const result = { targets: [{ path: "E:/project/audio/song.mp3", kind: "file", inProject: true }], truncated: false };
  mocks.invoke.mockResolvedValueOnce(result);
  await expect(resolveTerminalLink("E:/project", "E:/project/src", "song.mp3")).resolves.toEqual(result);
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("resolve_terminal_link", {
    projectPath: "E:/project", workingDirectory: "E:/project/src", path: "song.mp3",
  });
});
