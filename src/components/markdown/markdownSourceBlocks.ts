export type MarkdownSourceBlockKind =
  | "code"
  | "heading"
  | "html"
  | "list"
  | "paragraph"
  | "quote"
  | "rule"
  | "table";

export interface MarkdownSourceBlock {
  id: string;
  kind: MarkdownSourceBlockKind;
  start: number;
  end: number;
  source: string;
}

interface SourceLine {
  start: number;
  end: number;
  text: string;
}

function getSourceLines(content: string): SourceLine[] {
  if (!content) return [];
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf("\n", start);
    const rawEnd = newline < 0 ? content.length : newline;
    const end = rawEnd > start && content[rawEnd - 1] === "\r" ? rawEnd - 1 : rawEnd;
    lines.push({ start, end, text: content.slice(start, end) });
    if (newline < 0) break;
    start = newline + 1;
  }
  return lines;
}

function isFence(line: string) {
  return /^\s*(`{3,}|~{3,})/.exec(line);
}

function isHeading(line: string) {
  return /^\s{0,3}#{1,6}\s+/.test(line);
}

function isRule(line: string) {
  return /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line);
}

function isList(line: string) {
  return /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line);
}

function isQuote(line: string) {
  return /^\s*>/.test(line);
}

function isTableSeparator(line: string) {
  const value = line.trim().replace(/^\||\|$/g, "");
  if (!value.includes("-")) return false;
  const cells = value.split("|").map((cell) => cell.trim());
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function startsStandaloneBlock(lines: SourceLine[], index: number) {
  const line = lines[index]?.text ?? "";
  const nextLine = lines[index + 1]?.text ?? "";
  return Boolean(
    isFence(line) ||
      isHeading(line) ||
      isRule(line) ||
      isList(line) ||
      isQuote(line) ||
      line.trimStart().startsWith("<") ||
      (line.includes("|") && isTableSeparator(nextLine)),
  );
}

export function getMarkdownSourceBlocks(content: string): MarkdownSourceBlock[] {
  const lines = getSourceLines(content);
  const blocks: MarkdownSourceBlock[] = [];
  let index = 0;

  const pushBlock = (startLine: number, endLine: number, kind: MarkdownSourceBlockKind) => {
    const start = lines[startLine].start;
    const end = lines[endLine].end;
    blocks.push({
      id: `${start}:${end}`,
      kind,
      start,
      end,
      source: content.slice(start, end),
    });
  };

  while (index < lines.length) {
    if (!lines[index].text.trim()) {
      index += 1;
      continue;
    }

    const startLine = index;
    const line = lines[index].text;
    const fence = isFence(line);
    if (fence) {
      const marker = fence[1][0];
      const minimumLength = fence[1].length;
      index += 1;
      while (index < lines.length) {
        const closing = new RegExp(`^\\s*${marker}{${minimumLength},}\\s*$`);
        if (closing.test(lines[index].text)) break;
        index += 1;
      }
      pushBlock(startLine, Math.min(index, lines.length - 1), "code");
      index += 1;
      continue;
    }

    if (line.includes("|") && isTableSeparator(lines[index + 1]?.text ?? "")) {
      index += 2;
      while (index < lines.length && lines[index].text.trim() && lines[index].text.includes("|")) {
        index += 1;
      }
      pushBlock(startLine, index - 1, "table");
      continue;
    }

    if (line.trimStart().startsWith("<")) {
      index += 1;
      while (
        index < lines.length &&
        lines[index].text.trim() &&
        (lines[index].text.trimStart().startsWith("<") || lines[index].text.includes("<img"))
      ) {
        index += 1;
      }
      pushBlock(startLine, index - 1, "html");
      continue;
    }

    if (isHeading(line)) {
      pushBlock(startLine, startLine, "heading");
      index += 1;
      continue;
    }

    if (isRule(line)) {
      pushBlock(startLine, startLine, "rule");
      index += 1;
      continue;
    }

    if (isList(line)) {
      index += 1;
      while (index < lines.length && lines[index].text.trim()) {
        if (!isList(lines[index].text) && startsStandaloneBlock(lines, index)) break;
        index += 1;
      }
      pushBlock(startLine, index - 1, "list");
      continue;
    }

    if (isQuote(line)) {
      index += 1;
      while (index < lines.length && isQuote(lines[index].text)) index += 1;
      pushBlock(startLine, index - 1, "quote");
      continue;
    }

    index += 1;
    while (index < lines.length && lines[index].text.trim() && !startsStandaloneBlock(lines, index)) {
      index += 1;
    }
    pushBlock(startLine, index - 1, "paragraph");
  }

  return blocks;
}

export function replaceMarkdownSourceBlock(
  content: string,
  block: Pick<MarkdownSourceBlock, "start" | "end">,
  source: string,
) {
  return `${content.slice(0, block.start)}${source}${content.slice(block.end)}`;
}
