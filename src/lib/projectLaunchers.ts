export interface LauncherTerminal {
  title: string;
  directory: string;
  command: string;
}

export interface ProjectLauncher {
  id: string;
  name: string;
  terminals: LauncherTerminal[];
}

export interface ProjectLauncherFile {
  version: 1;
  launchers: ProjectLauncher[];
}

/** 示例只进入编辑草稿，用户保存后才写入项目。 */
export function createLauncherExample(name: string, terminalTitle: string): ProjectLauncherFile {
  return {
    version: 1,
    launchers: [{
      id: "dev",
      name,
      terminals: [{ title: terminalTitle, directory: ".", command: "" }],
    }],
  };
}
