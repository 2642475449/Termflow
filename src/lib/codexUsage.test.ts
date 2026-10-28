import { describe, expect, it } from "vitest";
import {
  shouldLoadClaudeRateLimits,
  shouldLoadCodexRateLimits,
  shouldLoadQoderUsage,
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

describe("shouldLoadQoderUsage", () => {
  it("loads usage only for an active Qoder session", () => {
    expect(shouldLoadQoderUsage({ active: true, agentId: "qoder" })).toBe(true);
    expect(shouldLoadQoderUsage({ active: false, agentId: "qoder" })).toBe(false);
    expect(shouldLoadQoderUsage({ active: true, agentId: "codex" })).toBe(false);
  });
});

describe("shouldLoadClaudeRateLimits", () => {
  it("loads plan usage only for an active Claude session", () => {
    expect(shouldLoadClaudeRateLimits({ active: true, agentId: "claude" })).toBe(true);
    expect(shouldLoadClaudeRateLimits({ active: false, agentId: "claude" })).toBe(false);
    expect(shouldLoadClaudeRateLimits({ active: true, agentId: "codex" })).toBe(false);
  });
});

