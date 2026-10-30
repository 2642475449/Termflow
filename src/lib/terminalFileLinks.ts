import type { TerminalLinkResolution, TerminalLinkTarget } from "./api/terminalLinks";
import { getFileExtension, supportsOfficePreview } from "./officePreview";

export interface TerminalLinkContext {
  projectPath: string;
  workingDirectory: string;
}

export const TERMINAL_LINK_CONTEXT_CHANGED = "terminal.linkContextChanged";

export function assertTerminalLinkProject(context: TerminalLinkContext, currentProjectPath: string | undefined): void {
  if (currentProjectPath !== context.projectPath) throw new Error(TERMINAL_LINK_CONTEXT_CHANGED);
}

/** 等待双击选择完成，防止第一个 mouseup 抢先打开浮层；修饰键点击保持即时。 */
export function createTerminalLinkActivationGate(hasSelection: () => boolean) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return {
    dispose,
    activate<T>(action: () => T, directly = false): T | undefined {
      dispose();
      if (hasSelection()) return;
      if (directly) return action();
      timer = setTimeout(() => {
        timer = undefined;
        if (!hasSelection()) action();
      }, 250);
    },
  };
}

type ResolveLink = (projectPath: string, workingDirectory: string, path: string) => Promise<TerminalLinkResolution>;

/** 悬浮验证复用结果；实际点击必须重新验证，避免已删除文件或旧目录的缓存。 */
export function createTerminalFileLinkResolver(resolve: ResolveLink, now = Date.now) {
  const cache = new Map<string, { expiresAt: number; result: Promise<TerminalLinkResolution> }>();
  return (context: TerminalLinkContext, path: string, fresh = false): Promise<TerminalLinkResolution> => {
    const key = JSON.stringify([context.projectPath, context.workingDirectory, path]);
    const cached = cache.get(key);
    if (!fresh && cached && cached.expiresAt > now()) return cached.result;
    if (cache.size >= 256) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    const result = resolve(context.projectPath, context.workingDirectory, path);
    const entry = { expiresAt: now() + 5_000, result };
    cache.set(key, entry);
    void result.catch(() => {
      if (cache.get(key) === entry) cache.delete(key);
    });
    return result;
  };
}

export function getUnambiguousTerminalTarget(resolution: TerminalLinkResolution): TerminalLinkTarget | null {
  return !resolution.truncated && resolution.targets.length === 1 ? resolution.targets[0] : null;
}

// 这些格式即使采样内容碰巧是 UTF-8，也不应进入文本编辑器；未知二进制由内容检测兜底。
const SYSTEM_FILE_EXTENSIONS = new Set([
  "mp3", "wav", "flac", "aac", "m4a", "ogg", "oga", "opus", "wma", "aiff", "mid", "midi",
  "mp4", "mkv", "avi", "mov", "webm", "wmv", "m4v", "mpeg", "mpg", "3gp",
  "zip", "7z", "rar", "gz", "bz2", "xz", "tar", "zst", "tgz", "iso",
]);

export interface TerminalTargetOpenActions {
  inspect: (projectPath: string, path: string) => Promise<{ kind: "text" | "image" | "pdf" | "binary" }>;
  openSystem: (path: string) => Promise<void>;
  openPreview: (path: string) => void;
  openEditor: (path: string, location?: { line: number; column: number }) => void;
}

/** 文件类型决定展示方式，识别层无需维护“可点击文件”的后缀白名单。 */
export async function openTerminalFileTarget(
  target: TerminalLinkTarget,
  context: TerminalLinkContext,
  location: { line?: number; column?: number },
  actions: TerminalTargetOpenActions,
): Promise<void> {
  if (!target.inProject || target.kind === "directory") {
    await actions.openSystem(target.path);
    return;
  }
  // 使用当前工作区的根路径表示项目内资源，保留 Windows 大小写及 junction 别名。
  const separator = context.projectPath.includes("\\") ? "\\" : "/";
  const path = target.projectRelativePath === undefined ? target.path
    : target.projectRelativePath === "" ? context.projectPath
    : `${context.projectPath.replace(/[\\/]+$/, "")}${separator}${target.projectRelativePath.replace(/[\\/]/g, separator)}`;
  if (SYSTEM_FILE_EXTENSIONS.has(getFileExtension(target.path))) {
    await actions.openSystem(target.path);
    return;
  }
  const status = await actions.inspect(context.projectPath, path);
  if (status.kind === "binary" && !supportsOfficePreview(target.path)) {
    await actions.openSystem(target.path);
  } else if (status.kind === "pdf" || (/\.(?:md|markdown)$/i.test(target.path) && !location.line)) {
    actions.openPreview(path);
  } else {
    actions.openEditor(path, status.kind === "text" && location.line
      ? { line: location.line, column: location.column ?? 1 }
      : undefined);
  }
}
