// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import type { CodexRateLimits, UsageQuotaWindow } from "@/types";

vi.mock("react-i18next", async () => {
  const { createInstance } = await import("i18next");
  const en = (await import("@/locales/en-US.json")).default;
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  return { useTranslation: () => ({ t: i18n.t, i18n }) };
});
import { QuotaDetailsContent, QuotaUsageStatus } from "./QuotaUsageStatus";

const window = (minutes: number, used: number): UsageQuotaWindow => ({ id: String(minutes), usedPercent: used, windowMinutes: minutes, resetsAt: null, resetDescription: null, bucketId: "codex", bucketName: null, label: null });
test("a balance-only response renders zero as a known balance without an unavailable warning", () => {
  const markup = renderToStaticMarkup(createElement(QuotaDetailsContent, { details: { balances: [{ bucketId: "codex", bucketName: null, balance: 0, hasCredits: false, unlimited: false }] } }));
  expect(markup).toContain("Credits balance");
  expect(markup).not.toContain("did not report quota");
  expect(markup).toContain(">0<");
});
test("Codex compact text and bar both report the exhausted weekly constraint", () => {
  const limits: CodexRateLimits = { session: null, weekly: null, quotaWindows: [window(300, 5), window(10080, 100)], status: "ok", error: null, updatedAt: Date.now(), accountId: null, accountLabel: null };
  const markup = renderToStaticMarkup(createElement(QuotaUsageStatus, { agentId: "codex", limits, isLoading: false, error: null, onRefresh: () => {} }));
  expect(markup).toContain("0% Weekly");
  expect(markup).toContain("width:0%");
});
test("a gateway budget with no dollar amounts remains a valid quota window", () => {
  const markup = renderToStaticMarkup(createElement(QuotaDetailsContent, { details: { quotaWindows: [{ ...window(0, 80), label: "monthlySpend" }] } }));
  expect(markup).toContain("Monthly spend limit");
  expect(markup).toContain("20%");
  expect(markup).not.toContain("Estimated spend");
});
test("OpenCode does not advertise one provider's remaining quota as the whole session's quota", () => {
  const markup = renderToStaticMarkup(createElement(QuotaUsageStatus, { agentId: "opencode", limits: { accounts: [{ provider: "opencode-go", status: "ok", error: null, quotaWindows: [window(300, 80)] }], status: "ok", error: null, updatedAt: Date.now() }, isLoading: false, error: null, onRefresh: () => {} }));
  expect(markup).toContain("OpenCode usage");
  expect(markup).not.toContain("20%");
});

test("OpenCode popover opens with Go windows and Zen explanation, and refresh remains clickable", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const refresh = vi.fn();
  try {
    await act(async () => root.render(createElement(QuotaUsageStatus, {
      agentId: "opencode", isLoading: false, error: null, onRefresh: refresh,
      limits: { status: "ok", error: null, updatedAt: Date.now(), accounts: [
        { provider: "opencode-go", status: "ok", error: null, quotaWindows: [window(300, 25), { ...window(0, 50), label: "monthly" }] },
        { provider: "opencode", status: "ok", error: null, emptyReason: "consoleQuota" },
      ] },
    })));
    await act(async () => host.querySelector("button")!.click());
    const popup = document.querySelector(".ant-popover");
    expect(popup?.textContent).toContain("OpenCode Go");
    expect(popup?.textContent).toContain("Monthly");
    expect(popup?.textContent).toContain("Check your balance in the OpenCode console");
    const refreshButton = popup?.querySelector('button[title="Refresh"]') as HTMLButtonElement;
    expect(refreshButton).toBeTruthy();
    await act(async () => refreshButton.click());
    expect(refresh).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
