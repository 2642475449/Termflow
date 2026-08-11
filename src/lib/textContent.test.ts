import { describe, expect, it } from "vitest";
import { stripAnsiEscapeSequences } from "./textContent";

describe("stripAnsiEscapeSequences", () => {
  it("removes terminal color and reset sequences", () => {
    expect(stripAnsiEscapeSequences("\u001b[36mvite\u001b[39m building\u001b[0m")).toBe(
      "vite building",
    );
  });

  it("removes OSC terminal sequences while preserving their text", () => {
    expect(stripAnsiEscapeSequences("\u001b]8;;https://example.com\u001b\\docs\u001b]8;;\u001b\\")).toBe(
      "docs",
    );
  });

  it("preserves ordinary text", () => {
    expect(stripAnsiEscapeSequences("plain build output")).toBe("plain build output");
  });
});
