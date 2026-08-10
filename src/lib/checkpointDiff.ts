import type { GitDiffHunk } from "@/types";

export interface UnifiedDiffRow {
  content: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  origin: " " | "+" | "-" | "\\";
  annotation?: string;
}

export interface CollapsedContextSection {
  position: number;
  rows: UnifiedDiffRow[];
}

function contentLines(content: string): string[] {
  if (!content) return [];
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Adds reliable old/new line numbers to Git's sequential unified-diff lines.
 * Every source line remains its own visual row so the code can use the full
 * width of the review pane.
 */
export function buildUnifiedCheckpointDiffRows(hunk: GitDiffHunk): UnifiedDiffRow[] {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  const rows: UnifiedDiffRow[] = [];

  for (const line of hunk.lines) {
    if (line.origin === "-") {
      const lineNumber = line.oldLineno ?? oldLine;
      oldLine = lineNumber + 1;
      rows.push({
        content: line.content,
        oldLineNumber: lineNumber,
        newLineNumber: null,
        origin: "-",
      });
      continue;
    }
    if (line.origin === "+") {
      const lineNumber = line.newLineno ?? newLine;
      newLine = lineNumber + 1;
      rows.push({
        content: line.content,
        oldLineNumber: null,
        newLineNumber: lineNumber,
        origin: "+",
      });
      continue;
    }

    if (line.origin === "\\") {
      rows.push({
        content: line.content,
        oldLineNumber: null,
        newLineNumber: null,
        origin: "\\",
        annotation: line.content,
      });
      continue;
    }

    const oldNumber = line.oldLineno ?? oldLine;
    const newNumber = line.newLineno ?? newLine;
    oldLine = oldNumber + 1;
    newLine = newNumber + 1;
    rows.push({
      content: line.content,
      oldLineNumber: oldNumber,
      newLineNumber: newNumber,
      origin: " ",
    });
  }

  return rows;
}

/**
 * Builds unchanged ranges omitted by Git's contextual hunks. The position is
 * the index of the hunk after the range; hunks.length means the trailing range.
 */
export function buildCollapsedContextSections(
  hunks: GitDiffHunk[],
  originalContent: string,
  modifiedContent: string,
): CollapsedContextSection[] {
  if (hunks.length === 0) return [];

  const original = contentLines(originalContent);
  const modified = contentLines(modifiedContent);
  const sections: CollapsedContextSection[] = [];

  for (let position = 0; position <= hunks.length; position += 1) {
    const previous = position > 0 ? hunks[position - 1] : null;
    const next = position < hunks.length ? hunks[position] : null;
    const oldStart = previous ? Math.max(1, previous.oldStart + previous.oldLines) : 1;
    const newStart = previous ? Math.max(1, previous.newStart + previous.newLines) : 1;
    const oldEnd = next ? next.oldStart : original.length + 1;
    const newEnd = next ? next.newStart : modified.length + 1;
    const oldCount = Math.max(0, oldEnd - oldStart);
    const newCount = Math.max(0, newEnd - newStart);
    const rowCount = Math.max(oldCount, newCount);
    if (rowCount === 0) continue;

    const rows: UnifiedDiffRow[] = [];
    for (let index = 0; index < rowCount; index += 1) {
      rows.push({
        content: modified[newStart - 1 + index]
          ?? original[oldStart - 1 + index]
          ?? "",
        oldLineNumber: index < oldCount ? oldStart + index : null,
        newLineNumber: index < newCount ? newStart + index : null,
        origin: " ",
      });
    }
    sections.push({ position, rows });
  }

  return sections;
}
