import { expect, it } from "vitest";
import { antigravityQuotaLabel } from "./antigravityQuota";

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
