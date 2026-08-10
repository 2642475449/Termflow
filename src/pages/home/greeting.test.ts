import { describe, expect, it } from "vitest";
import { createGreetingSelection, getGreetingPeriod } from "./greeting";

function atHour(hour: number): Date {
  return new Date(2026, 6, 14, hour);
}

describe("getGreetingPeriod", () => {
  it.each([
    [0, "evening"],
    [4, "evening"],
    [5, "morning"],
    [10, "morning"],
    [11, "noon"],
    [12, "noon"],
    [13, "afternoon"],
    [17, "afternoon"],
    [18, "evening"],
    [23, "evening"],
  ] as const)("maps %i:00 to %s", (hour, period) => {
    expect(getGreetingPeriod(atHour(hour))).toBe(period);
  });
});

describe("createGreetingSelection", () => {
  it("selects either copy variant for the current period", () => {
    expect(createGreetingSelection(atHour(8), () => 0.49)).toEqual({
      period: "morning",
      variant: "first",
    });
    expect(createGreetingSelection(atHour(8), () => 0.5)).toEqual({
      period: "morning",
      variant: "second",
    });
  });
});
