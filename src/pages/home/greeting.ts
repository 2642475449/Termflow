export type GreetingPeriod = "morning" | "noon" | "afternoon" | "evening";
export type GreetingVariant = "first" | "second";

export interface GreetingSelection {
  period: GreetingPeriod;
  variant: GreetingVariant;
}

export function getGreetingPeriod(date: Date): GreetingPeriod {
  const hour = date.getHours();

  if (hour >= 5 && hour < 11) {
    return "morning";
  }
  if (hour >= 11 && hour < 13) {
    return "noon";
  }
  if (hour >= 13 && hour < 18) {
    return "afternoon";
  }
  return "evening";
}

export function createGreetingSelection(
  date: Date,
  random: () => number = Math.random
): GreetingSelection {
  return {
    period: getGreetingPeriod(date),
    variant: random() < 0.5 ? "first" : "second",
  };
}
