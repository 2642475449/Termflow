import { describe, expect, it } from "vitest";
import { getNotificationSuppressionReason } from "./attentionDiagnostics";

describe("getNotificationSuppressionReason", () => {
  const defaults = {
    enabled: true,
    foreground: false,
    eventType: "assistant_complete",
    durationMs: 20_000,
    completionThresholdMs: 10_000,
  };

  it("explains disabled, foreground and duration suppression in policy order", () => {
    expect(getNotificationSuppressionReason({ ...defaults, enabled: false })).toBe(
      "notifications-disabled"
    );
    expect(getNotificationSuppressionReason({ ...defaults, foreground: true })).toBe(
      "foreground-session"
    );
    expect(getNotificationSuppressionReason({ ...defaults, durationMs: 5_000 })).toBe(
      "below-duration-threshold"
    );
  });

  it("keeps external long-task notifications eligible while the session is visible", () => {
    expect(
      getNotificationSuppressionReason({
        ...defaults,
        foreground: true,
        suppressWhenForeground: false,
        durationMs: 60_000,
        completionThresholdMs: 60_000,
      })
    ).toBeNull();

    expect(
      getNotificationSuppressionReason({
        ...defaults,
        foreground: true,
        suppressWhenForeground: false,
        durationMs: 59_999,
        completionThresholdMs: 60_000,
      })
    ).toBe("below-duration-threshold");
  });

  it("allows long completion and non-completion events", () => {
    expect(getNotificationSuppressionReason(defaults)).toBeNull();
    expect(
      getNotificationSuppressionReason({
        ...defaults,
        eventType: "permission_request",
        durationMs: 0,
      })
    ).toBeNull();
  });

  it("requires a measured lifecycle duration for every completion alert", () => {
    expect(
      getNotificationSuppressionReason({
        ...defaults,
        durationMs: null,
      })
    ).toBe("completion-duration-unavailable");
  });
});
