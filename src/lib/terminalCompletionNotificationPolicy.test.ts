import { describe, expect, it } from "vitest";
import {
  getTerminalCompletionDeliverySuppressionReason,
  getTerminalCompletionIngestSuppressionReason,
} from "./terminalCompletionNotificationPolicy";

describe("getTerminalCompletionIngestSuppressionReason", () => {
  it("requires the feature to be enabled and a measured duration at the threshold", () => {
    expect(
      getTerminalCompletionIngestSuppressionReason({
        enabled: false,
        durationMs: 30_000,
        thresholdMs: 30_000,
      }),
    ).toBe("notifications-disabled");
    expect(
      getTerminalCompletionIngestSuppressionReason({
        enabled: true,
        durationMs: null,
        thresholdMs: 30_000,
      }),
    ).toBe("completion-duration-unavailable");
    expect(
      getTerminalCompletionIngestSuppressionReason({
        enabled: true,
        durationMs: 29_999,
        thresholdMs: 30_000,
      }),
    ).toBe("below-duration-threshold");
    expect(
      getTerminalCompletionIngestSuppressionReason({
        enabled: true,
        durationMs: 30_000,
        thresholdMs: 30_000,
      }),
    ).toBeNull();
  });
});

describe("getTerminalCompletionDeliverySuppressionReason", () => {
  it("distinguishes an observed terminal from a hidden terminal in the foreground window", () => {
    expect(
      getTerminalCompletionDeliverySuppressionReason({
        externalNotificationsEnabled: true,
        targetObserved: true,
        windowForeground: true,
      }),
    ).toBe("foreground-session");
    expect(
      getTerminalCompletionDeliverySuppressionReason({
        externalNotificationsEnabled: true,
        targetObserved: false,
        windowForeground: true,
      }),
    ).toBe("foreground-window");
    expect(
      getTerminalCompletionDeliverySuppressionReason({
        externalNotificationsEnabled: true,
        targetObserved: false,
        windowForeground: false,
      }),
    ).toBeNull();
  });
});
