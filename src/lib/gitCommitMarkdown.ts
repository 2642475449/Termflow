const FENCE_PATTERN = /^\s*(`{3,}|~{3,})/;
const CLOSING_FENCE_PATTERN = /^\s*(`{3,}|~{3,})\s*$/;
const HEADING_PATTERN = /^\s{0,3}(#{1,6})\s+(.*)$/;
const LIST_ITEM_PATTERN = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/;
const INLINE_PATTERN =
  /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\n]+\*|_[^_\n]+_)|(~~[^~\n]+~~)|(https?:\/\/[^\s<]+|www\.[^\s<]+)/g;

export type CommitMarkdownInlineKind = "text" | "code" | "strong" | "em" | "del" | "link";

export interface CommitMarkdownInlineToken {
  kind: CommitMarkdownInlineKind;
  text: string;
  href?: string;
}

export interface CommitMarkdownHeading {
  level: number;
  text: string;
}

export interface CommitMarkdownListItem {
  text: string;
  ordered: boolean;
}

function splitLines(source: string) {
  return source.replace(/\r\n/g, "\n").split("\n");
}

export function parseCommitMarkdownHeading(
  source: string,
): CommitMarkdownHeading | null {
  const match = HEADING_PATTERN.exec(splitLines(source)[0] ?? "");
  if (!match) return null;
  return { level: match[1].length, text: match[2].trim() };
}

export function parseCommitMarkdownList(
  source: string,
): CommitMarkdownListItem[] {
  const items: CommitMarkdownListItem[] = [];
  for (const line of splitLines(source)) {
    const match = LIST_ITEM_PATTERN.exec(line);
    if (match) {
      items.push({ text: match[4].trim(), ordered: Boolean(match[3]) });
      continue;
    }
    const text = line.trim();
    if (!text || items.length === 0) continue;
    // 列表项的续行按 Markdown 懒惰续行语义并入上一项
    const last = items[items.length - 1];
    last.text = `${last.text} ${text}`;
  }
  return items;
}

export function parseCommitMarkdownCode(source: string): string {
  const lines = splitLines(source);
  const start = FENCE_PATTERN.test(lines[0] ?? "") ? 1 : 0;
  const end = CLOSING_FENCE_PATTERN.test(lines[lines.length - 1] ?? "")
    ? lines.length - 1
    : lines.length;
  return lines.slice(start, Math.max(start, end)).join("\n");
}

export function parseCommitMarkdownQuote(source: string): string {
  return splitLines(source)
    .map((line) => line.replace(/^\s{0,3}>\s?/, ""))
    .join("\n");
}

export function parseCommitMarkdownInline(
  source: string,
): CommitMarkdownInlineToken[] {
  const tokens: CommitMarkdownInlineToken[] = [];
  let lastIndex = 0;

  const pushText = (text: string) => {
    if (!text) return;
    const previous = tokens[tokens.length - 1];
    if (previous?.kind === "text") {
      previous.text = `${previous.text}${text}`;
      return;
    }
    tokens.push({ kind: "text", text });
  };

  for (const match of source.matchAll(INLINE_PATTERN)) {
    const start = match.index ?? 0;
    pushText(source.slice(lastIndex, start));
    lastIndex = start + match[0].length;

    if (match[1] !== undefined) {
      tokens.push({ kind: "code", text: match[1] });
    } else if (match[2] !== undefined) {
      tokens.push({ kind: "link", text: match[2], href: match[3] });
    } else if (match[4] !== undefined) {
      tokens.push({ kind: "strong", text: match[4].slice(2, -2) });
    } else if (match[5] !== undefined) {
      tokens.push({ kind: "em", text: match[5].slice(1, -1) });
    } else if (match[6] !== undefined) {
      tokens.push({ kind: "del", text: match[6].slice(2, -2) });
    } else {
      const href = match[7].startsWith("www.") ? `https://${match[7]}` : match[7];
      tokens.push({ kind: "link", text: match[7], href });
    }
  }

  pushText(source.slice(lastIndex));
  return tokens;
}
