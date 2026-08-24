import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";

export interface ParsedPath {
  filePath: string;
  line?: number;
  column?: number;
}

export interface DetectedFilePath extends ParsedPath {
  text: string;
  startIndex: number;
}

export type FilePathLinkValidator = (path: ParsedPath) => Promise<boolean>;
export type FilePathLinkHandler = (path: ParsedPath, openDirectly: boolean) => unknown;
export type FilePathLinkHoverHandler = (path: ParsedPath, event: MouseEvent) => unknown;

interface LogicalBufferLineSegment {
  row: number;
  text: string;
  bufferColumns?: number[];
}

interface LogicalBufferLine {
  text: string;
  segments: LogicalBufferLineSegment[];
}

const FILE_EXTENSIONS = [
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "py", "go", "java",
  "c", "cpp", "h", "hpp", "css", "scss", "less", "html", "vue", "svelte",
  "json", "jsonc", "yaml", "yml", "toml", "xml", "md", "mdx", "txt",
  "sh", "bash", "zsh", "ps1", "sql", "graphql", "gql", "proto", "env", "lock", "pdf",
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif",
];

const EXTENSION_PATTERN = [...FILE_EXTENSIONS]
  .sort((left, right) => right.length - left.length)
  .join("|");
// Keep Chinese and other Unicode filename characters valid, but stop at the
// punctuation that commonly joins natural-language clauses. Existence is still
// verified before the candidate becomes a link.
const PATH_CHARACTER = String.raw`[^\s\\/:*?"'\`()<>{}\[\]|,，。；：！？、]`;

// File links accept known extensions. Directory links are limited to absolute
// paths or ASCII relative paths with a trailing separator to avoid matching prose.
const FILE_PATH_PATTERN = new RegExp(
  String.raw`(?:[a-zA-Z]:[\\/]|\\\\|\/|\.\.?[\\/])(?:${PATH_CHARACTER}+[\\/])*${PATH_CHARACTER}+\.(?:${EXTENSION_PATTERN})(?::\d+)?(?::\d+)?` +
    "|" +
    String.raw`(?:${PATH_CHARACTER}+[\\/])+${PATH_CHARACTER}+\.(?:${EXTENSION_PATTERN})(?::\d+)?(?::\d+)?` +
    "|" +
    String.raw`${PATH_CHARACTER}+\.(?:${EXTENSION_PATTERN})(?::\d+)?(?::\d+)?` +
    "|" +
    String.raw`(?:[a-zA-Z]:[\\/]|\\\\)(?:${PATH_CHARACTER}+[\\/])*${PATH_CHARACTER}+` +
    "|" +
    String.raw`\/(?:${PATH_CHARACTER}+[\\/])+${PATH_CHARACTER}+` +
    "|" +
    String.raw`(?:[a-zA-Z0-9_@.-]+[\\/])+`,
  "gi",
);

export function parseTerminalFilePath(text: string): ParsedPath {
  const lineAndColumn = text.match(/^(.+):(\d+):(\d+)$/);
  if (lineAndColumn) {
    return {
      filePath: lineAndColumn[1],
      line: Number.parseInt(lineAndColumn[2], 10),
      column: Number.parseInt(lineAndColumn[3], 10),
    };
  }

  const lineOnly = text.match(/^(.+):(\d+)$/);
  if (lineOnly) {
    return { filePath: lineOnly[1], line: Number.parseInt(lineOnly[2], 10) };
  }

  return { filePath: text };
}

export function detectTerminalFilePaths(line: string): DetectedFilePath[] {
  const matches: DetectedFilePath[] = [];
  const pattern = new RegExp(FILE_PATH_PATTERN.source, FILE_PATH_PATTERN.flags);
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(line)) !== null) {
    // WebLinksAddon owns URLs; do not claim a path-looking suffix from one.
    const tokenStart = line.lastIndexOf(" ", match.index - 1) + 1;
    if (line.slice(tokenStart, match.index + match[0].length).includes("://")) continue;

    matches.push({
      text: match[0],
      startIndex: match.index,
      ...parseTerminalFilePath(match[0]),
    });
  }

  return matches;
}

export function resolveTerminalFilePath(filePath: string, workingDirectory: string): string {
  const trimmedPath = filePath.trim();
  if (/^[a-zA-Z]:[\\/]/.test(trimmedPath) || trimmedPath.startsWith("\\\\")) {
    return normalizePathSegments(trimmedPath, "\\");
  }
  if (trimmedPath.startsWith("/")) return normalizePathSegments(trimmedPath, "/");

  const separator = workingDirectory.includes("\\") ? "\\" : "/";
  return normalizePathSegments(`${workingDirectory}${separator}${trimmedPath}`, separator);
}

function normalizePathSegments(path: string, separator: "\\" | "/"): string {
  const normalized = path.replace(/[\\/]/g, separator);
  const unc = separator === "\\" && normalized.startsWith("\\\\");
  const drive = separator === "\\" ? normalized.match(/^[a-zA-Z]:/)?.[0] : undefined;
  const absolute = normalized.startsWith(separator);
  const prefix = unc ? "\\\\" : drive ? `${drive}\\` : absolute ? separator : "";
  const body = drive ? normalized.slice(3) : unc ? normalized.slice(2) : absolute ? normalized.slice(1) : normalized;
  const segments: string[] = [];

  for (const segment of body.split(separator)) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0) segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return prefix + segments.join(separator);
}

export class FilePathLinkProvider implements ILinkProvider {
  private readonly activatingPaths = new Set<string>();

  constructor(
    private readonly terminal: Terminal,
    private readonly onActivate: FilePathLinkHandler,
    private readonly validatePath?: FilePathLinkValidator,
    private readonly onHover?: FilePathLinkHoverHandler,
    private readonly onLeave?: () => void,
  ) {}

  provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
    const logicalLine = this.getLogicalBufferLine(bufferLineNumber);
    if (!logicalLine?.text) {
      callback(undefined);
      return;
    }

    const candidates = detectTerminalFilePaths(logicalLine.text).flatMap((detected) => {
      const start = this.logicalIndexToBufferPosition(logicalLine, detected.startIndex);
      const end = this.logicalIndexToBufferPosition(
        logicalLine,
        detected.startIndex + detected.text.length - 1,
      );
      if (!start || !end || bufferLineNumber < start.y || bufferLineNumber > end.y) return [];

      return [{ detected, start, end }];
    });

    if (candidates.length === 0) {
      callback(undefined);
      return;
    }

    const createLink = ({ detected, start, end }: typeof candidates[number]): ILink => ({
        range: { start, end },
        text: detected.text,
        decorations: { pointerCursor: true, underline: true },
        activate: (event) => {
          if (event.button !== 0) return;
          const path = {
            filePath: detected.filePath,
            line: detected.line,
            column: detected.column,
          };
          const activationKey = `${path.filePath}:${path.line ?? ""}:${path.column ?? ""}`;
          if (this.activatingPaths.has(activationKey)) return;

          this.activatingPaths.add(activationKey);
          try {
            void Promise.resolve(this.onActivate(path, Boolean(event.ctrlKey || event.metaKey))).finally(() => {
              this.activatingPaths.delete(activationKey);
            });
          } catch (error) {
            this.activatingPaths.delete(activationKey);
            throw error;
          }
        },
        hover: (event) => this.onHover?.(detected, event),
        leave: () => this.onLeave?.(),
      });

    if (!this.validatePath) {
      const links = candidates.map(createLink);
      callback(links.length > 0 ? links : undefined);
      return;
    }

    void Promise.all(candidates.map(async (candidate) => {
      const isValid = await this.validatePath!(candidate.detected).catch(() => false);
      return isValid ? createLink(candidate) : undefined;
    })).then((links) => {
      const verifiedLinks = links.filter((link): link is ILink => Boolean(link));
      callback(verifiedLinks.length > 0 ? verifiedLinks : undefined);
    });
  }

  private getLogicalBufferLine(bufferLineNumber: number): LogicalBufferLine | undefined {
    const buffer = this.terminal.buffer.active;
    let startIndex = bufferLineNumber - 1;
    if (!buffer.getLine(startIndex)) return undefined;

    // A wrapped xterm row is a continuation of the previous row. Walk in both
    // directions so a hover on any visual row sees the complete logical line.
    while (startIndex > 0 && buffer.getLine(startIndex)?.isWrapped) {
      startIndex -= 1;
    }

    let endIndex = startIndex;
    while (endIndex + 1 < buffer.length && buffer.getLine(endIndex + 1)?.isWrapped) {
      endIndex += 1;
    }

    const segments: LogicalBufferLineSegment[] = [];
    for (let index = startIndex; index <= endIndex; index += 1) {
      const line = buffer.getLine(index);
      if (!line) break;
      const hasWrappedContinuation = index < endIndex;
      const text = line.translateToString(!hasWrappedContinuation, 0, this.terminal.cols);
      segments.push({
        row: index + 1,
        // Preserve the full width before a soft wrap; only the final row may
        // discard padding. Otherwise the next row would be joined too early.
        text,
        bufferColumns: this.mapStringIndicesToBufferColumns(line, text),
      });
    }

    return {
      text: segments.map((segment) => segment.text).join(""),
      segments,
    };
  }

  private logicalIndexToBufferPosition(
    logicalLine: LogicalBufferLine,
    logicalIndex: number,
  ): { x: number; y: number } | undefined {
    if (logicalIndex < 0) return undefined;

    let remaining = logicalIndex;
    for (const segment of logicalLine.segments) {
      if (remaining < segment.text.length) {
        return {
          x: segment.bufferColumns?.[remaining] ?? remaining + 1,
          y: segment.row,
        };
      }
      remaining -= segment.text.length;
    }

    return undefined;
  }

  private mapStringIndicesToBufferColumns(
    line: NonNullable<ReturnType<Terminal["buffer"]["active"]["getLine"]>>,
    text: string,
  ): number[] | undefined {
    if (typeof line.getCell !== "function") return undefined;

    const columns: number[] = [];
    let stringIndex = 0;
    for (let column = 0; column < this.terminal.cols && stringIndex < text.length; column += 1) {
      const cell = line.getCell(column);
      if (!cell || cell.getWidth() === 0) continue;

      const chars = cell.getChars() || " ";
      for (let offset = 0; offset < chars.length && stringIndex < text.length; offset += 1) {
        columns[stringIndex] = column + 1;
        stringIndex += 1;
      }
    }

    return stringIndex === text.length ? columns : undefined;
  }
}
