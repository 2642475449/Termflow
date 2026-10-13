import { describe, expect, it } from "vitest";
import {
  containsTerminalInterrupt,
  consumeTerminalSubmissionInput,
  hasTerminalPromptText,
  terminalInputContainsInsertedText,
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

  it("recognizes standalone Esc as an Antigravity interrupt only", () => {
    expect(containsTerminalInterrupt("\x1b", "antigravity")).toBe(true);
    expect(containsTerminalInterrupt("\x1b", "claude")).toBe(false);
    expect(containsTerminalInterrupt("\x1b")).toBe(false);
    expect(containsTerminalInterrupt("\x03", "antigravity")).toBe(true);
  });

  it.each(["\x1b[A", "\x1b[B", "\x1bOP", "\x1b[200~text\x1b[201~", "\x1bx"])(
    "does not treat the input sequence %j as an Antigravity interrupt",
    (input) => expect(containsTerminalInterrupt(input, "antigravity")).toBe(false),
  );

  it("keeps the next prompt's first character after standalone Esc", () => {
    const escape = consumeTerminalSubmissionInput("", "\x1b");
    expect(escape.pendingSequence).toBe("");
    const typing = consumeTerminalSubmissionInput(escape.nextValue, "你", escape.pendingSequence);
    const submission = consumeTerminalSubmissionInput(typing.nextValue, "\r", typing.pendingSequence);
    expect(submission.submittedText).toBe("你");
  });

  it("preserves a draft on Esc and still consumes split navigation sequences", () => {
    expect(consumeTerminalSubmissionInput("draft", "\x1b").nextValue).toBe("draft");
    const prefix = consumeTerminalSubmissionInput("draft", "\x1b[");
    const navigation = consumeTerminalSubmissionInput(prefix.nextValue, "A", prefix.pendingSequence);
    expect(navigation.nextValue).toBe("draft");
    expect(navigation.pendingSequence).toBe("");
  });

  it("tracks bracketed paste content without counting its control sequences", () => {
    const paste = consumeTerminalSubmissionInput("", "\x1b[200~hello\x1b[201~");
    const submission = consumeTerminalSubmissionInput(paste.nextValue, "\r");

    expect(submission.submittedText).toBe("hello");
  });

  it("detects when a pasted image path has been removed from the prompt", () => {
    const insertedText = '"C:\\tmp\\image.png"';

    expect(terminalInputContainsInsertedText(`explain ${insertedText}`, insertedText)).toBe(true);
    expect(terminalInputContainsInsertedText("explain ", insertedText)).toBe(false);
    expect(terminalInputContainsInsertedText('explain "C:\\tmp\\image.pn"', insertedText)).toBe(false);
  });
});
