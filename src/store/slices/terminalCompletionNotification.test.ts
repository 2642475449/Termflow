import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_COMPLETION_NOTIFICATION_THRESHOLD_MS,
  MAX_TERMINAL_COMPLETION_NOTIFICATION_THRESHOLD_MS,
  MIN_TERMINAL_COMPLETION_NOTIFICATION_THRESHOLD_MS,
  normalizeTerminalCompletionNotificationThreshold,
} from "./terminalCompletionNotification";

describe("normalizeTerminalCompletionNotificationThreshold", () => {
  it("uses the PowerShell completion default for absent or invalid values", () => {
    expect(normalizeTerminalCompletionNotificationThreshold(undefined)).toBe(
      DEFAULT_TERMINAL_COMPLETION_NOTIFICATION_THRESHOLD_MS,
    );
    expect(normalizeTerminalCompletionNotificationThreshold(Number.NaN)).toBe(
      DEFAULT_TERMINAL_COMPLETION_NOTIFICATION_THRESHOLD_MS,
    );
  });

  it("keeps the threshold within the supported ten-second to ten-minute range", () => {
    expect(normalizeTerminalCompletionNotificationThreshold(1)).toBe(
      MIN_TERMINAL_COMPLETION_NOTIFICATION_THRESHOLD_MS,
    );
    expect(normalizeTerminalCompletionNotificationThreshold(700_000)).toBe(
      MAX_TERMINAL_COMPLETION_NOTIFICATION_THRESHOLD_MS,
    );
    expect(normalizeTerminalCompletionNotificationThreshold(30_200.5)).toBe(30_201);
  });
});
