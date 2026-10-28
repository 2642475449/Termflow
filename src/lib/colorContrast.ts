/**
 * 颜色对比度工具：按 WCAG 2.x 计算文字与背景的对比度，并解析 themes.css 中的主题变量。
 * 用于在单元测试中守护“文字/背景组合必须满足最低对比度”这一设计基本法则。
 */

/** WCAG AA 普通正文与浮层（Tooltip/Popover）的最低对比度 */
export const MIN_TEXT_CONTRAST_RATIO = 4.5;

/** WCAG 主色按钮/徽标等实心控件文字的最低对比度（防止深底深字或浅底浅字） */
export const MIN_UI_CONTRAST_RATIO = 3.5;

const HEX_COLOR_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const CSS_VARIABLE_REFERENCE_PATTERN = /^var\(\s*--cs-([\w-]+)\s*(?:,.*)?\)$/;

/** 解析 #rgb / #rrggbb，返回 0-255 的 RGB 分量；不支持的格式抛错，避免静默通过 */
export function parseHexColor(color: string): [number, number, number] {
  const value = color.trim();
  const match = value.match(HEX_COLOR_PATTERN);
  if (!match) {
    throw new Error(`Unsupported color for contrast check: ${color}`);
  }
  const hex = match[1].length === 3
    ? match[1].split("").map((char) => char + char).join("")
    : match[1];
  return [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ];
}

/** WCAG 相对亮度 */
export function getRelativeLuminance(color: string): number {
  const [r, g, b] = parseHexColor(color).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 两色对比度（1-21），与前景/背景顺序无关 */
export function getContrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [
    getRelativeLuminance(foreground),
    getRelativeLuminance(background),
  ].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

/** 从 `var(--cs-text-primary)` 中取出变量名 `text-primary`，非变量引用返回 null */
export function getCssVariableName(value: string): string | null {
  return value.trim().match(CSS_VARIABLE_REFERENCE_PATTERN)?.[1] ?? null;
}

/**
 * 读取 themes.css 中某个主题块的 `--cs-*` 变量，并展开 `var(--cs-*)` 引用链。
 * 返回的键不含 `--cs-` 前缀。
 */
export function readThemeVariables(css: string, theme: string): Record<string, string> {
  const selector = `[data-theme="${theme}"] {`;
  const start = css.indexOf(selector);
  if (start < 0) {
    throw new Error(`Theme block not found: ${theme}`);
  }
  const block = css.slice(start + selector.length, css.indexOf("}", start));
  const raw: Record<string, string> = {};
  for (const match of block.matchAll(/--cs-([\w-]+):\s*([^;]+);/g)) {
    raw[match[1]] = match[2].trim();
  }

  const resolve = (name: string, seen: Set<string>): string => {
    const value = raw[name];
    if (value === undefined) {
      throw new Error(`Theme variable --cs-${name} is not defined in ${theme}`);
    }
    const reference = getCssVariableName(value);
    if (!reference) return value;
    if (seen.has(reference)) {
      throw new Error(`Circular theme variable reference: --cs-${name}`);
    }
    seen.add(reference);
    return resolve(reference, seen);
  };

  return Object.fromEntries(
    Object.keys(raw).map((name) => [name, resolve(name, new Set([name]))]),
  );
}
