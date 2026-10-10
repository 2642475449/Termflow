import { afterEach, describe, expect, it, vi } from "vitest";
import * as monaco from "monaco-editor";
import themeCss from "../styles/themes.css?raw";
vi.mock("monaco-editor", () => ({
  editor: { defineTheme: vi.fn(), setTheme: vi.fn() },
  languages: { onLanguage: vi.fn(), setMonarchTokensProvider: vi.fn() },
}));

import { getMonacoThemeName, getMonacoTypography, observeMonacoTheme } from "./monaco";

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

function mockThemeStyles(theme: string) {
  const block = themeCss.match(new RegExp(`\\[data-theme="${theme}"\\] \\{([^}]+)\\}`))?.[1];
  if (!block) throw new Error(`Missing theme: ${theme}`);
  vi.stubGlobal("document", { documentElement: {} });
  vi.stubGlobal("getComputedStyle", () => ({
    getPropertyValue: (key: string) => block.match(new RegExp(`^\\s*${key}:\\s*([^;]+)`, "m"))?.[1] ?? "",
  }));
}

describe("getMonacoTypography", () => {
  it("disables programming ligatures to avoid WebView2 operator rendering artifacts", () => {
    expect(getMonacoTypography(14)).toMatchObject({
      fontSize: 14,
      fontLigatures: false,
    });
  });
});

it("keeps theme lookup safe without a browser", () => {
  expect(getMonacoThemeName(false)).toBe("vs");
  expect(getMonacoThemeName(true)).toBe("vs-dark");
});

it.each(["light-glass", "light-warm", "dark-starry", "dark-mocha"])("uses %s colors for readable code, guides and highlights", (theme) => {
  mockThemeStyles(theme);
  getMonacoThemeName(theme.startsWith("dark"));
  const definition = vi.mocked(monaco.editor.defineTheme).mock.calls[0][1];
  expect(definition.rules).toContainEqual(expect.objectContaining({ token: "comment", fontStyle: "" }));
  expect(definition.colors["editor.background"]).toMatch(/^#[\da-f]{6}$/i);
  expect(definition.colors["editorIndentGuide.background1"]).toMatch(/^#[\da-f]{6}80$/i);
  expect(definition.colors["editor.selectionHighlightBackground"]).toMatch(/^#[\da-f]{6}18$/i);
});

it("refreshes Monaco after the CSS theme changes within the same color category", () => {
  mockThemeStyles("light-glass");
  let refresh = () => {};
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal("MutationObserver", class {
    constructor(callback: () => void) { refresh = callback; }
    observe = observe;
    disconnect = disconnect;
  });
  const subscription = observeMonacoTheme(false);
  const initial = vi.mocked(monaco.editor.defineTheme).mock.calls[0][1].colors["editor.background"];
  mockThemeStyles("light-warm");
  refresh();
  const updated = vi.mocked(monaco.editor.defineTheme).mock.calls[1][1].colors["editor.background"];
  expect(updated).not.toBe(initial);
  expect(monaco.editor.setTheme).toHaveBeenLastCalledWith("termflow-light");
  expect(observe).toHaveBeenCalledWith(expect.any(Object), { attributes: true, attributeFilter: ["data-theme"] });
  subscription.dispose();
  expect(disconnect).toHaveBeenCalledOnce();
});
