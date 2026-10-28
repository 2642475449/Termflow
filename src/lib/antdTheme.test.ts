import { expect, it } from "vitest";
import themeCss from "../styles/themes.css?raw";
import {
  getContrastRatio,
  getCssVariableName,
  MIN_TEXT_CONTRAST_RATIO,
  MIN_UI_CONTRAST_RATIO,
  readThemeVariables,
} from "./colorContrast";
import {
  ANTD_COMPONENT_OVERRIDES,
  ANTD_PRIMARY_COLORS,
  ANTD_TEXT_LIGHT_SOLID,
  WINDOW_CLOSE_BUTTON_COLORS,
} from "./antdTheme";

const THEMES = Object.keys(ANTD_PRIMARY_COLORS) as Array<keyof typeof ANTD_PRIMARY_COLORS>;

/** 读取组件 token 指向的主题变量值；token 必须写成 var(--cs-*) 才能随主题切换 */
function resolveToken(theme: string, token: string): string {
  const name = getCssVariableName(token);
  expect(name, `token ${token} must reference a --cs-* theme variable`).not.toBeNull();
  return readThemeVariables(themeCss, theme)[name as string];
}

it("keeps antd primary colors aligned with --cs-primary", () => {
  for (const theme of THEMES) {
    expect(ANTD_PRIMARY_COLORS[theme].toLowerCase()).toBe(
      readThemeVariables(themeCss, theme).primary.toLowerCase(),
    );
  }
});

it("keeps text on antd primary surfaces readable", () => {
  for (const theme of THEMES) {
    const ratio = getContrastRatio(
      resolveToken(theme, ANTD_TEXT_LIGHT_SOLID),
      ANTD_PRIMARY_COLORS[theme],
    );
    expect(ratio, `${theme} primary button text`).toBeGreaterThanOrEqual(MIN_UI_CONTRAST_RATIO);
  }
});

it("overrides tooltip text and background as a pair", () => {
  // 回归：全局 colorTextLightSolid 为近黑色时，Tooltip 若沿用 AntD 默认灰色背景会变成灰底深字
  const tooltip = ANTD_COMPONENT_OVERRIDES.Tooltip;
  expect(tooltip.colorTextLightSolid).toBeDefined();
  expect(tooltip.colorBgSpotlight).toBeDefined();

  for (const theme of THEMES) {
    const ratio = getContrastRatio(
      resolveToken(theme, tooltip.colorTextLightSolid),
      resolveToken(theme, tooltip.colorBgSpotlight),
    );
    expect(ratio, `${theme} tooltip`).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST_RATIO);
  }
});

it("keeps window close glyphs readable on hover and pressed backgrounds in every theme", () => {
  for (const theme of THEMES) {
    for (const colors of Object.values(WINDOW_CLOSE_BUTTON_COLORS)) {
      expect(getContrastRatio(
        resolveToken(theme, colors.foreground),
        resolveToken(theme, colors.background),
      )).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST_RATIO);
    }
  }
});
