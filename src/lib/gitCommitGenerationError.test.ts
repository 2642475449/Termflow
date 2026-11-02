import { expect, it } from "vitest";
import { parseGitCommitGenerationError } from "./gitCommitGenerationError";

it("preserves a structured capacity failure and its actual attempt count", () => {
  expect(parseGitCommitGenerationError({
    code: "capacity", attempts: 3, exitCode: 1, detail: "ERROR: Selected model is at capacity.",
  })).toEqual({ code: "capacity", attempts: 3, exitCode: 1, detail: "ERROR: Selected model is at capacity." });
});

it("accepts serialized IPC errors without turning the JSON envelope into user copy", () => {
  expect(parseGitCommitGenerationError(new Error(JSON.stringify({
    code: "quota", attempts: 1, detail: "insufficient_quota", exitCode: 1,
  })))).toEqual({ code: "quota", attempts: 1, detail: "insufficient_quota", exitCode: 1 });
});

it("extracts and deduplicates the actual CLI error after a long echoed prompt", () => {
  const text = `OpenAI Codex\nuser\n${"private prompt and diff\n".repeat(1_000)}\x1b[31mERROR: Selected model is at capacity.\x1b[0m\nERROR: Selected model is at capacity.`;
  const error = parseGitCommitGenerationError(text);
  expect(error.detail).toBe("ERROR: Selected model is at capacity.");
  expect(error.detail).not.toContain("private prompt");
});

it("bounds legacy diagnostics and tolerates unknown or malformed errors", () => {
  expect(parseGitCommitGenerationError("x".repeat(5_000)).detail).toHaveLength(240);
  expect(parseGitCommitGenerationError({ code: "unknown", attempts: NaN, exitCode: Infinity })).toEqual({
    code: "processFailed", attempts: 1, exitCode: null, detail: "",
  });
  expect(parseGitCommitGenerationError(undefined).detail).toBe("");
  expect(parseGitCommitGenerationError("{invalid JSON").code).toBe("processFailed");
});
