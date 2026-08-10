import { describe, expect, it } from "vitest";
import {
  shouldLoadClaudeRateLimits,
  shouldLoadCodexRateLimits,
  shouldShowClaudeRateLimits,
} from "./codexUsage";

describe("shouldLoadCodexRateLimits", () => {
  it("loads usage only for an active Codex session", () => {
    expect(shouldLoadCodexRateLimits({ active: true, agentId: "codex" })).toBe(true);
  });

  it("does not load usage when there is no selected session", () => {
    expect(shouldLoadCodexRateLimits(null)).toBe(false);
  });

  it("does not load usage for an inactive Codex history item", () => {
    expect(shouldLoadCodexRateLimits({ active: false, agentId: "codex" })).toBe(false);
  });

  it("does not load usage for another active agent", () => {
    expect(shouldLoadCodexRateLimits({ active: true, agentId: "claude" })).toBe(false);
  });
});

describe("shouldLoadClaudeRateLimits", () => {
  it("loads plan usage only for an active Claude session", () => {
    expect(shouldLoadClaudeRateLimits({ active: true, agentId: "claude" })).toBe(true);
    expect(shouldLoadClaudeRateLimits({ active: false, agentId: "claude" })).toBe(false);
    expect(shouldLoadClaudeRateLimits({ active: true, agentId: "codex" })).toBe(false);
  });
});

describe("shouldShowClaudeRateLimits", () => {
  it("hides the status bar item while Claude plan usage is unavailable", () => {
    expect(shouldShowClaudeRateLimits(null)).toBe(false);
    expect(shouldShowClaudeRateLimits({
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: null,
      status: "unavailable",
    })).toBe(false);
  });

  it("shows the status bar item only after a real rate-limit window arrives", () => {
    expect(shouldShowClaudeRateLimits({
      session: {
        usedPercent: 21,
        windowMinutes: 300,
        resetsAt: null,
        resetDescription: null,
      },
      weekly: null,
      updatedAt: Date.now(),
      error: null,
      status: "ok",
    })).toBe(true);
  });
});

