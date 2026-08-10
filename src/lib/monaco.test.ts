import { describe, expect, it } from "vitest";
import { getMonacoTypography } from "./monaco";

describe("getMonacoTypography", () => {
  it("disables programming ligatures to avoid WebView2 operator rendering artifacts", () => {
    expect(getMonacoTypography(14)).toMatchObject({
      fontSize: 14,
      fontLigatures: false,
    });
  });
});
