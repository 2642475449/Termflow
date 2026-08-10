import { describe, expect, it } from "vitest";
import {
  containsTerminalInterrupt,
  consumeTerminalSubmissionInput,
  hasTerminalPromptText,
} from "./terminalSubmission";

describe("terminal submission tracking", () => {
  it("treats a bare Enter used by a confirmation menu as interaction", () => {
    const result = consumeTerminalSubmissionInput("", "\r");

    expect(result.submittedText).toBe("");
    expect(hasTerminalPromptText(result.submittedText)).toBe(false);
  });

  it("ignores arrow-key navigation before confirming a menu", () => {
    const navigation = consumeTerminalSubmissionInput("", "\x1b[B");
    const confirmation = consumeTerminalSubmissionInput(
      navigation.nextValue,
      "\r",
      navigation.pendingSequence,
    );

    expect(confirmation.submittedText).toBe("");
    expect(hasTerminalPromptText(confirmation.submittedText)).toBe(false);
  });

  it("recognizes a typed prompt before Enter", () => {
    const typing = consumeTerminalSubmissionInput("", "你好");
    const submission = consumeTerminalSubmissionInput(typing.nextValue, "\r");

    expect(submission.submittedText).toBe("你好");
    expect(hasTerminalPromptText(submission.submittedText)).toBe(true);
  });

  it("clears prompt tracking for Ctrl+U and Ctrl+C", () => {
    const ctrlU = consumeTerminalSubmissionInput("draft", "\x15\r");
    const ctrlC = consumeTerminalSubmissionInput("draft", "\x03\r");

    expect(hasTerminalPromptText(ctrlU.submittedText)).toBe(false);
    expect(hasTerminalPromptText(ctrlC.submittedText)).toBe(false);
  });

  it("recognizes Ctrl+C as a terminal interrupt", () => {
    expect(containsTerminalInterrupt("\x03")).toBe(true);
    expect(containsTerminalInterrupt("draft\x03")).toBe(true);
    expect(containsTerminalInterrupt("draft")).toBe(false);
  });

  it("tracks bracketed paste content without counting its control sequences", () => {
    const paste = consumeTerminalSubmissionInput("", "\x1b[200~hello\x1b[201~");
    const submission = consumeTerminalSubmissionInput(paste.nextValue, "\r");

    expect(submission.submittedText).toBe("hello");
  });
});
