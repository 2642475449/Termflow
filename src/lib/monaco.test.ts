import { describe, expect, it, vi } from "vitest";
vi.mock("monaco-editor", () => ({
  editor: { defineTheme: vi.fn() },
  languages: { onLanguage: vi.fn(), setMonarchTokensProvider: vi.fn() },
}));

import { getMonacoThemeName, getMonacoTypography } from "./monaco";

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
