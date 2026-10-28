import { expect, it } from "vitest";
import themeCss from "../styles/themes.css?raw";
import {
  getContrastRatio,
  getCssVariableName,
  MIN_TEXT_CONTRAST_RATIO,
  MIN_UI_CONTRAST_RATIO,
  parseHexColor,
  readThemeVariables,
} from "./colorContrast";

const THEMES = ["light-glass", "light-warm", "dark-starry", "dark-mocha"] as const;

/** 界面中实际出现的“正文/浮层文字 × 底色”组合，任何主题都必须满足 WCAG AA (4.5:1) */
const TEXT_SURFACE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["text-primary", "bg-app"],
  ["text-primary", "bg-card-solid"],
  ["text-primary", "bg-elevated"],
  ["text-primary", "bg-hover"],
  ["text-primary", "bg-active"],
  ["text-secondary", "bg-app"],
  ["text-secondary", "bg-card-solid"],
  ["text-secondary", "bg-elevated"],
  ["text-secondary", "bg-hover"],
  ["text-secondary", "bg-active"],
  ["text-tertiary", "bg-app"],
  ["text-tertiary", "bg-card-solid"],
  ["text-tertiary", "bg-elevated"],
];

it("parses short and long hex colors", () => {
  expect(parseHexColor("#fff")).toEqual([255, 255, 255]);
  expect(parseHexColor("#15171B")).toEqual([21, 23, 27]);
  expect(() => parseHexColor("rgba(0, 0, 0, 0.5)")).toThrow();
});

it("computes WCAG contrast ratios regardless of argument order", () => {
  expect(getContrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
  expect(getContrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  expect(getContrastRatio("#777777", "#ffffff")).toBeCloseTo(
    getContrastRatio("#ffffff", "#777777"),
    10,
  );
});

it("extracts theme variable names from var() references", () => {
  expect(getCssVariableName("var(--cs-text-primary)")).toBe("text-primary");
  expect(getCssVariableName("var(--cs-border-card, var(--cs-border))")).toBe("border-card");
  expect(getCssVariableName("#ffffff")).toBeNull();
});

it("resolves nested theme variable references", () => {
  const variables = readThemeVariables(themeCss, "light-glass");
  expect(variables["bg-sidebar"]).toBe(variables["bg-card-solid"]);
  expect(variables["text-quaternary"]).toBe(variables["text-tertiary"]);
});

it("keeps every text and surface pair above WCAG AA in all themes", () => {
  const failures: string[] = [];
  for (const theme of THEMES) {
    const variables = readThemeVariables(themeCss, theme);
    for (const [foreground, background] of TEXT_SURFACE_PAIRS) {
      const ratio = getContrastRatio(variables[foreground], variables[background]);
      if (ratio < MIN_TEXT_CONTRAST_RATIO) {
        failures.push(`${theme}: --cs-${foreground} on --cs-${background} = ${ratio.toFixed(2)}`);
      }
    }
    const onPrimaryRatio = getContrastRatio(variables["text-on-primary"], variables.primary);
    if (onPrimaryRatio < MIN_UI_CONTRAST_RATIO) {
      failures.push(`${theme}: --cs-text-on-primary on --cs-primary = ${onPrimaryRatio.toFixed(2)}`);
    }
  }
  expect(failures).toEqual([]);
});
