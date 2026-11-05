import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { parseTerminalFileUrl } from "@/lib/terminalWebLinks";

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
  bufferColumns?: { starts: number[]; ends: number[] };
}

interface LogicalBufferLine {
  text: string;
  segments: LogicalBufferLineSegment[];
}

// Link detection is synchronous on the UI thread. Keep rendering long output,
// but do not parse or allocate per-cell maps for oversized logical lines.
export const MAX_TERMINAL_LINK_LINE_LENGTH = 16_384;

// 先取完整候选再判断路径信号，避免未知扩展名被截成目录或已知后缀。
// 最终是否成为链接仍由文件存在性校验决定，不把格式支持限制为扩展名白名单。
const PATH_TOKEN_PATTERN = /(?:[a-zA-Z]:)?(?:[^\s:*?"'`()<>{}\[\]|│┃║,，。；：！？、;]+|\([^()\s]*\))+(?::\d+){0,2}/gu;
const URI_PATTERN = /[a-zA-Z][a-zA-Z\d+.-]*:\/\/[^\s"'`<>|│┃║，。；：！？、]+/g;
// 明确的 Windows/UNC 起点和文件后缀可确定未加引号的含空格文件路径边界。
// 含空格且无扩展名的路径需要引号或 Markdown 括号，避免把后面的说明并入目录名。
const SPACED_ABSOLUTE_FILE_PATTERN = /(?<![\w])(?:[a-zA-Z]:[\\/]|\\\\)[^\r\n\t:*?"'`<>|│┃║,;，。；：！？、]+?\.[^\s\\/:*?"'`<>|│┃║,;，。；：！？、]+(?::\d+){0,2}(?=$|[\s"'`),;:|│┃║，。；：！？、\]])/gi;

function isPathCandidate(text: string, allowBareName = false): boolean {
  if (!text || /[\r\n\u0000-\u001f]/.test(text) || text.includes("://")) return false;
  const { filePath } = parseTerminalFilePath(text);
  if (filePath === "." || filePath === ".." || filePath === "/" || filePath === "\\") return false;
  if (/^(?:[a-zA-Z]:[\\/]|\\\\|\/\/|~[\\/]|\.\.?[\\/]|\/)/.test(filePath)) return true;
  const hasFilenameSuffix = /\.[^./\\\s]+$/.test(filePath) && /[\p{L}_]/u.test(filePath);
  if (/[\\/]/.test(filePath)) {
    // 无扩展名的纯中文斜杠短语容易来自正文；显式 ./、引号和后缀可消除歧义。
    return allowBareName || hasFilenameSuffix || /[a-zA-Z0-9_]/.test(filePath) || /[\\/]$/.test(filePath);
  }
  return hasFilenameSuffix || (allowBareName && /^[\p{L}\p{N}_. -]+$/u.test(filePath));
}

function trimSentencePunctuation(text: string): string {
  let result = text;
  // 标点和外层括号可以连续出现，例如 path.txt.)；引号内的文件名不走此裁剪。
  while (true) {
    const previous = result;
    result = result.replace(/[.,!;:]+$/, "");
    for (const [open, close] of [["(", ")"], ["[", "]"]]) {
      while (result.endsWith(close) && result.split(close).length > result.split(open).length) {
        result = result.slice(0, -1);
      }
    }
    if (result === previous) return result;
  }
}

function normalizeWindowsDrivePrefix(path: string): string {
  // Markdown 本地链接常用 /C:/path；文件系统需要 C:/path，UNC 和 POSIX 根路径保持原样。
  return path.replace(/^\/(?=[a-zA-Z]:[\\/])/, "");
}

function indexClosingDelimiters(text: string, open: string, close: string): Int32Array {
  const ends = new Int32Array(text.length).fill(-1);
  // suffix[i] is the next unmatched closer when scanning from i. Working
  // backwards lets each opener skip an already indexed balanced expression.
  const suffix = new Int32Array(text.length + 2).fill(-1);
  let angleEnd = -1;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const char = text[index];
    if (char === ">") angleEnd = index;
    if (open === "[" && char === "\\") {
      suffix[index] = suffix[index + 2];
    } else if (char === close) {
      suffix[index] = index;
    } else if (char === open) {
      // Only a destination's initial angle wrapper hides parentheses.
      const contentStart = open === "(" && text[index + 1] === "<"
        ? (angleEnd < 0 ? -1 : angleEnd + 1)
        : index + 1;
      const end = contentStart < 0 ? -1 : suffix[contentStart];
      ends[index] = end;
      // A nested opener does not start the outer destination's angle wrapper.
      const nestedEnd = suffix[index + 1];
      suffix[index] = nestedEnd < 0 ? -1 : suffix[nestedEnd + 1];
    } else {
      suffix[index] = suffix[index + 1];
    }
  }
  return ends;
}

export function parseTerminalFilePath(text: string): ParsedPath {
  text = normalizeWindowsDrivePrefix(text);
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
  if (line.length > MAX_TERMINAL_LINK_LINE_LENGTH) return [];
  const labelEnds = indexClosingDelimiters(line, "[", "]");
  const destinationEnds = indexClosingDelimiters(line, "(", ")");
  const matches: DetectedFilePath[] = [];
  const reservedRanges: Array<{ start: number; end: number }> = [];
  const overlapsReservedRange = (start: number, length: number) => reservedRanges.some(
    (range) => start < range.end && start + length > range.start,
  );
  const addPath = (text: string, startIndex: number, allowBareName = false, displayText = text) => {
    const parsed = parseTerminalFilePath(text);
    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(parsed.filePath) && !/^[a-zA-Z]:[\\/]/.test(parsed.filePath)) {
      const path = parseTerminalFileUrl(text);
      if (path) matches.push({ text: displayText, startIndex, ...parseTerminalFilePath(path) });
      return;
    }
    if (isPathCandidate(text, allowBareName)) {
      matches.push({ text: displayText, startIndex, ...parsed });
    }
  };

  // 先按结构识别 Markdown 和引号，标题只负责展示，不能把版本号等文字猜成文件名。
  // 整条 Markdown 链接使用同一目标，让点击标题和跨行后的路径得到一致结果。
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' || char === "'" || char === "`") {
      const end = line.indexOf(char, index + 1);
      if (end < 0) continue;
      reservedRanges.push({ start: index, end: end + 1 });
      addPath(line.slice(index + 1, end), index + 1, true);
      index = end;
    } else if (char === "[") {
      const labelEnd = labelEnds[index];
      if (labelEnd < 0 || line[labelEnd + 1] !== "(") continue;
      const end = destinationEnds[labelEnd + 1];
      if (end < 0) continue;
      const destination = line.slice(labelEnd + 2, end).trim()
        .replace(/\s+(?:"[^"]*"|'[^']*')$/, "").replace(/^<([^<>]+)>$/, "$1");
      reservedRanges.push({ start: index, end: end + 1 });
      addPath(destination, index, true, line.slice(index, end + 1));
      index = end;
    }
  }

  // 终端展示常用外层括号包住路径；内部括号属于文件名。
  let parenthesisStart = -1;
  let parenthesisDepth = 0;
  for (let index = 0; index < line.length; index += 1) {
    if (overlapsReservedRange(index, 1)) continue;
    if (line[index] === "(") {
      if (parenthesisDepth === 0) parenthesisStart = index;
      parenthesisDepth += 1;
    } else if (line[index] === ")" && parenthesisDepth > 0) {
      parenthesisDepth -= 1;
      if (parenthesisDepth !== 0) continue;
      // 路径内部的括号属于文件名，不能把其中的 foo.ext 抢先注册成独立链接。
      const previous = line[parenthesisStart - 1];
      if (previous && /[\p{L}\p{N}_.~\\/)-]/u.test(previous)) continue;
      const text = line.slice(parenthesisStart + 1, index);
      if (text.includes("://") || isPathCandidate(text, line[parenthesisStart - 1] === "]")) {
        addPath(text, parenthesisStart + 1, line[parenthesisStart - 1] === "]");
        reservedRanges.push({ start: parenthesisStart, end: index + 1 });
      }
    }
  }

  for (const uri of line.matchAll(URI_PATTERN)) {
    if (overlapsReservedRange(uri.index, uri[0].length)) continue;
    const text = trimSentencePunctuation(uri[0]);
    // 其他 URI 整段占位，禁止从 URL 内部截出一个本地路径。
    reservedRanges.push({ start: uri.index, end: uri.index + uri[0].length });
    addPath(text, uri.index);
  }

  for (const absolute of line.matchAll(SPACED_ABSOLUTE_FILE_PATTERN)) {
    if (absolute[0].includes("://")) continue;
    if (overlapsReservedRange(absolute.index, absolute[0].length)) continue;
    addPath(trimSentencePunctuation(absolute[0]), absolute.index);
    reservedRanges.push({ start: absolute.index, end: absolute.index + absolute[0].length });
  }

  for (const match of line.matchAll(PATH_TOKEN_PATTERN)) {
    if (overlapsReservedRange(match.index, match[0].length)) continue;
    addPath(trimSentencePunctuation(match[0]), match.index);
  }

  return matches.sort((left, right) => left.startIndex - right.startIndex);
}

export function resolveTerminalFilePath(filePath: string, workingDirectory: string): string {
  const trimmedPath = normalizeWindowsDrivePrefix(filePath.trim());
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
        true,
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
          if (event.button !== 0 || event.altKey || this.terminal.hasSelection?.()) return;
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
    // Allow two cells per wide character and one padding cell. Bound traversal
    // before translating rows, then enforce the exact UTF-16 length below.
    const minRowLength = Math.max(1, Math.floor((this.terminal.cols - 1) / 2));
    const maxRows = Math.ceil(MAX_TERMINAL_LINK_LINE_LENGTH / minRowLength) + 1;
    while (startIndex > 0 && buffer.getLine(startIndex)?.isWrapped) {
      startIndex -= 1;
      if (bufferLineNumber - startIndex > maxRows) return undefined;
    }

    let endIndex = startIndex;
    while (endIndex + 1 < buffer.length && buffer.getLine(endIndex + 1)?.isWrapped) {
      endIndex += 1;
      if (endIndex - startIndex + 1 > maxRows) return undefined;
    }

    const segments: LogicalBufferLineSegment[] = [];
    let textLength = 0;
    for (let index = startIndex; index <= endIndex; index += 1) {
      const line = buffer.getLine(index);
      if (!line) break;
      const hasWrappedContinuation = index < endIndex;
      const lastCell = line.getCell?.(this.terminal.cols - 1);
      const nextCell = hasWrappedContinuation ? buffer.getLine(index + 1)?.getCell?.(0) : undefined;
      // 宽字符放不进末尾一格时，xterm 会留下 null 占位并把字符移到软换行首。
      // 只跳过这个占位；用户实际输出的空格有 getChars() === " "，必须保留。
      const hasWideWrapPadding = hasWrappedContinuation
        && lastCell?.getWidth() === 1 && lastCell.getChars() === ""
        && nextCell?.getWidth() === 2;
      const text = line.translateToString(!hasWrappedContinuation, 0, this.terminal.cols - Number(hasWideWrapPadding));
      textLength += text.length;
      if (textLength > MAX_TERMINAL_LINK_LINE_LENGTH) return undefined;
      segments.push({
        row: index + 1,
        // 保留软换行前的真实字符与空格，只丢弃宽字符换行的 null 占位。
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
    endOfCell = false,
  ): { x: number; y: number } | undefined {
    if (logicalIndex < 0) return undefined;

    let remaining = logicalIndex;
    for (const segment of logicalLine.segments) {
      if (remaining < segment.text.length) {
        return {
          x: (endOfCell ? segment.bufferColumns?.ends[remaining] : segment.bufferColumns?.starts[remaining]) ?? remaining + 1,
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
  ): LogicalBufferLineSegment["bufferColumns"] {
    if (typeof line.getCell !== "function") return undefined;

    const starts: number[] = [];
    const ends: number[] = [];
    let stringIndex = 0;
    for (let column = 0; column < this.terminal.cols && stringIndex < text.length; column += 1) {
      const cell = line.getCell(column);
      if (!cell || cell.getWidth() === 0) continue;

      const chars = cell.getChars() || " ";
      for (let offset = 0; offset < chars.length && stringIndex < text.length; offset += 1) {
        starts[stringIndex] = column + 1;
        ends[stringIndex] = Math.min(column + cell.getWidth(), this.terminal.cols);
        stringIndex += 1;
      }
    }

    return stringIndex === text.length ? { starts, ends } : undefined;
  }
}
