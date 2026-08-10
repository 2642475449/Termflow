import { describe, expect, it } from "vitest";
import {
  getTerminalTheme,
  TERMINAL_MINIMUM_CONTRAST_RATIO,
  TERMINAL_THEMES,
} from "./terminalTheme";

describe("terminal theme policy", () => {
  it("applies WCAG AA contrast protection to every terminal theme", () => {
    expect(TERMINAL_MINIMUM_CONTRAST_RATIO).toBe(4.5);

    for (const config of Object.values(TERMINAL_THEMES)) {
      expect(config.minimumContrastRatio).toBe(
        TERMINAL_MINIMUM_CONTRAST_RATIO,
      );
      expect(config.theme.background).toBe(config.cssBackground);
    }
  });

  it("keeps color scheme metadata with the palette", () => {
    expect(getTerminalTheme("light-glass").colorScheme).toBe("light");
    expect(getTerminalTheme("light-warm").colorScheme).toBe("light");
    expect(getTerminalTheme("dark-starry").colorScheme).toBe("dark");
    expect(getTerminalTheme("dark-mocha").colorScheme).toBe("dark");
  });
});
