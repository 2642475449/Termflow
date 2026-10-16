import type { AntigravityQuotaWindow } from "@/types";

type Translate = (key: string) => string;

export function antigravityQuotaScopeLabel(scope: string, t: Translate): string {
  if (scope === "Gemini") return t("settings.agents.quota.gemini");
  if (scope === "Claude and GPT") return t("settings.agents.quota.claudeGpt");
  if (scope === "Argon") return t("settings.agents.quota.argon");
  return scope;
}

export function antigravityQuotaPeriodLabel(period: string, t: Translate): string {
  if (period === "session") return t("settings.agents.quota.sessionShort");
  if (period === "weekly") return t("settings.agents.quota.weeklyShort");
  return period === "quota" ? "" : period;
}

export function antigravityQuotaLabel(window: AntigravityQuotaWindow, t: Translate): string {
  const scope = antigravityQuotaScopeLabel(window.scope, t);
  const period = antigravityQuotaPeriodLabel(window.window, t);
  return period ? `${scope} · ${period}` : scope;
}
