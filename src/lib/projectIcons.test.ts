import { expect, it } from "vitest";
import { getProjectIconColor, getProjectIconSource, isProjectIconEmoji } from "./projectIcons";
import { PROJECT_ICON_COLORS } from "./projectIcons";
import { getContrastRatio, parseHexColor, readThemeVariables } from "./colorContrast";
import themeCss from "@/styles/themes.css?raw";

it("retains the old six-color assignment and distributes new projects across twelve colors", () => {
  expect(getProjectIconColor("E:\\7.project\\test\\Termflow", 6)).toBe(0);
  const colors = new Set(Array.from({ length: 100 }, (_, n) => getProjectIconColor(`/project/${n}`)));
  expect(colors.size).toBe(12);
  expect(getProjectIconColor("/same")).toBe(getProjectIconColor("/same"));
});

it("keeps explicit overrides above auto detection", () => {
  expect(getProjectIconSource({ mode: "image", color: 1, image: "custom", revision: 1 }, "auto")).toBe("custom");
  expect(getProjectIconSource({ mode: "initials", color: 1, revision: 1 }, "auto")).toBeNull();
  expect(getProjectIconSource({ mode: "auto", color: 1, revision: 1 }, "auto")).toBe("auto");
});

it("accepts one complete emoji including joined and flag forms and rejects text or multiple emojis", () => {
  for (const emoji of ["🚀", "👩🏽‍💻", "🇨🇳", "1️⃣"]) expect(isProjectIconEmoji(emoji)).toBe(true);
  for (const text of ["", "AB", "项目", "🚀🚀", "hi🚀"]) expect(isProjectIconEmoji(text)).toBe(false);
});

it("keeps all twelve fallback colors readable in all four themes", () => {
  for (const theme of ["light-glass", "light-warm", "dark-starry", "dark-mocha"]) {
    const variables = readThemeVariables(themeCss, theme);
    const base = parseHexColor(variables["bg-card"]);
    for (const name of PROJECT_ICON_COLORS) {
      const color = parseHexColor(variables[`project-icon-${name}`]);
      const background = `#${color.map((channel, index) => Math.round(channel * 0.42 + base[index] * 0.58).toString(16).padStart(2, "0")).join("")}`;
      expect(getContrastRatio(variables["text-primary"], background), `${theme}/${name}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});
