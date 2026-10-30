import { invoke } from "@tauri-apps/api/core";

export interface TerminalLinkTarget {
  path: string;
  kind: "file" | "directory";
  inProject: boolean;
  projectRelativePath?: string;
}

export interface TerminalLinkResolution {
  targets: TerminalLinkTarget[];
  truncated: boolean;
}

export async function resolveTerminalLink(
  projectPath: string,
  workingDirectory: string,
  path: string,
): Promise<TerminalLinkResolution> {
  return await invoke("resolve_terminal_link", { projectPath, workingDirectory, path });
}
