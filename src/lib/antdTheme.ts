import type { ThemeConfig } from "antd";
import type { ThemeMode } from "@/store";

/**
 * Ant Design 主题 token 覆盖。
 *
 * 注意：AntD 的 `colorTextLightSolid` 不只用于主色按钮文字，Tooltip 等组件也用它作为文字色。
 * 全局把它设为 `--cs-text-on-primary`（深色主题下为近黑色）后，任何使用它的组件都必须
 * 同时显式指定配对的背景色，否则会出现“灰底深字”的低对比度问题。
 * 所有配色组合由 antdTheme.test.ts 按 WCAG AA 在 4 套主题下逐一校验。
 */

/** AntD colorPrimary：必须与 themes.css 中各主题的 --cs-primary 保持一致 */
export const ANTD_PRIMARY_COLORS: Record<ThemeMode, string> = {
  "light-glass": "#4263eb",
  "light-warm": "#c2713a",
  "dark-starry": "#8198ff",
  "dark-mocha": "#f5bd69",
};

/** 全局 colorTextLightSolid：主色背景上的文字 */
export const ANTD_TEXT_LIGHT_SOLID = "var(--cs-text-on-primary)";

/** 自定义窗口关闭按钮：红底与白色图标必须成对配置，与 shell.css 保持一致。 */
export const WINDOW_CLOSE_BUTTON_COLORS = {
  hover: {
    background: "var(--cs-window-close-hover-bg)",
    foreground: "var(--cs-window-close-text)",
  },
  pressed: {
    background: "var(--cs-window-close-pressed-bg)",
    foreground: "var(--cs-window-close-text)",
  },
} as const;

/** 组件级 token 覆盖：文字色与背景色必须成对出现 */
export const ANTD_COMPONENT_OVERRIDES = {
  Tooltip: {
    colorBgSpotlight: "var(--cs-bg-elevated)",
    colorTextLightSolid: "var(--cs-text-primary)",
  },
} satisfies NonNullable<ThemeConfig["components"]>;
