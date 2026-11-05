import { describe, expect, it } from "vitest";
import { buildAgentFileReferencePrompt as build, type AgentFileDropEntry } from "./terminalFileDrop";

const files = (...paths: string[]): AgentFileDropEntry[] => paths.map((path) => ({ path, kind: "file" }));

describe("terminal file drop references", () => {
  it("keeps mixed video, document, archive and image files in order", () => {
    expect(build({ agentId: "antigravity", projectPath: "D:/work", entries: files(
      "D:/work/录屏.mp4", "D:/work/notes.pdf", "D:/work/source.zip", "D:/work/screen.png",
    ) })).toBe("@录屏.mp4 @notes.pdf @source.zip @screen.png");
  });

  it("quotes paths with spaces and preserves external absolute paths", () => {
    expect(build({ agentId: "claude", projectPath: "D:/work", entries: files(
      "D:/work/my file.md", "C:/User Files/video.mp4",
    ) })).toBe('@"my file.md" @"C:/User Files/video.mp4"');
  });

  it("does not mistake a sibling project for a child", () => {
    expect(build({ agentId: "codex", projectPath: "D:/work", entries: files("D:/workspace/a.pdf") }))
      .toBe("D:/workspace/a.pdf");
  });

  it("matches Windows project paths without case sensitivity", () => {
    expect(build({ agentId: "codex", projectPath: "D:\\Work", entries: files("d:\\work\\a.mp4") }))
      .toBe("a.mp4");
  });

  it("preserves UNC paths", () => {
    expect(build({ agentId: "codex", projectPath: "D:/work", entries: files("\\\\server\\share\\a.pdf") }))
      .toBe("//server/share/a.pdf");
  });

  it("uses literal PowerShell strings for apostrophes and expressions", () => {
    expect(build({ agentId: "powershell", projectPath: "D:/work", entries: files("D:\\it's $(whoami).mp4") }))
      .toBe("'D:\\it''s $(whoami).mp4'");
  });

  it("quotes CMD paths containing spaces and command separators", () => {
    expect(build({ agentId: "cmd", projectPath: "D:/work", entries: files("D:\\video & notes\\a.mp4") }))
      .toBe('"D:\\video & notes\\a.mp4"');
  });

  it("retains directory semantics and removes terminal control characters", () => {
    expect(build({ agentId: "codex", projectPath: "D:/work", entries: [
      { path: "D:/work/docs", kind: "directory" }, ...files("D:/work/a\r\n\x1b.pdf", ""),
    ] })).toBe('docs (directory) "a   .pdf"');
  });
});
