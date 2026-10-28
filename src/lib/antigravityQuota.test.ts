import { expect, it } from "vitest";
import { antigravityQuotaLabel, getAntigravityGeminiQuotaWindows } from "./antigravityQuota";
import type { AntigravityQuotaWindow } from "@/types";

const t = (key: string) => ({
  "settings.agents.quota.gemini": "Gemini",
  "settings.agents.quota.claudeGpt": "Claude/GPT",
  "settings.agents.quota.argon": "Gemini 4 Argon",
  "settings.agents.quota.sessionShort": "5小时",
  "settings.agents.quota.weeklyShort": "每周",
})[key] ?? key;

it("keeps known quota labels localized", () => {
  expect(antigravityQuotaLabel({ id: "gemini-5h", scope: "Gemini", window: "session", remainingPercent: 50, resetDescription: null }, t))
    .toBe("Gemini · 5小时");
});

it("shows a future bucket using its reported group and period", () => {
  expect(antigravityQuotaLabel({ id: "new-model-monthly", scope: "new model", window: "monthly", remainingPercent: 72, resetDescription: null }, t))
    .toBe("new model · monthly");
});

it("summarizes Gemini without treating exhausted Claude/GPT quota as a Gemini limit", () => {
  const windows: AntigravityQuotaWindow[] = [
    { id: "gemini-5h", scope: "Gemini", window: "session", remainingPercent: 99, resetDescription: null },
    { id: "gemini-weekly", scope: "Gemini", window: "weekly", remainingPercent: 84, resetDescription: null },
    { id: "claude-weekly", scope: "Claude and GPT", window: "weekly", remainingPercent: 0, resetDescription: null },
    { id: "argon-weekly", scope: "gemini argon wtu", window: "weekly", remainingPercent: 67, resetDescription: null },
  ];
  const summary = getAntigravityGeminiQuotaWindows(windows);
  expect(summary.map((window) => window.id)).toEqual(["gemini-5h", "gemini-weekly"]);
  expect(Math.min(...summary.map((window) => window.remainingPercent))).toBe(84);
  expect(windows).toHaveLength(4);
});

it("does not present another model's quota as Gemini when Gemini is missing", () => {
  expect(getAntigravityGeminiQuotaWindows([
    { id: "claude", scope: "Claude and GPT", window: "session", remainingPercent: 100, resetDescription: null },
  ])).toEqual([]);
  expect(getAntigravityGeminiQuotaWindows([])).toEqual([]);
});

it("keeps Gemini exhaustion visible even if another model has remaining quota", () => {
  expect(getAntigravityGeminiQuotaWindows([
    { id: "claude", scope: "Claude and GPT", window: "session", remainingPercent: 100, resetDescription: null },
    { id: "gemini", scope: "Gemini", window: "weekly", remainingPercent: 0, resetDescription: null },
  ]).map((window) => window.remainingPercent)).toEqual([0]);
});
