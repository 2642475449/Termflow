const ANSI_ESCAPE_SEQUENCE =
  /(?:\u001b\][\s\S]*?(?:\u0007|\u001b\\)|\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]))/g;

/**
 * Removes terminal control sequences that have no useful representation in a
 * file editor. Build logs often contain these sequences for terminal colors.
 */
export function stripAnsiEscapeSequences(content: string): string {
  return content.replace(ANSI_ESCAPE_SEQUENCE, "");
}
