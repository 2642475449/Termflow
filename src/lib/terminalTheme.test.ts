import { describe, expect, it } from "vitest";
import themeCss from "../styles/themes.css?raw";
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

  it("keeps terminal surfaces and cursor colors aligned with every UI theme", () => {
    const css = themeCss;
    for (const [name, config] of Object.entries(TERMINAL_THEMES)) {
      const selector = `[data-theme="${name}"] {`;
      const start = css.indexOf(selector);
      expect(start).toBeGreaterThanOrEqual(0);
      const block = css.slice(start, css.indexOf("}", start));
      const value = (property: string) =>
        block.match(new RegExp(`--cs-${property}:\\s*([^;]+);`))?.[1].trim();

      expect(config.cssBackground).toBe(value("bg-card-solid"));
      expect(config.theme.foreground).toBe(value("text-primary"));
      expect(config.theme.cursor).toBe(value("primary"));
    }
  });
});
