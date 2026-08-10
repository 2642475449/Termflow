import { describe, expect, it } from "vitest";
import { normalizeTerminalRendererValue } from "./index";

describe("terminal renderer preference", () => {
  it("keeps WebGL as an explicit opt-in", () => {
    expect(normalizeTerminalRendererValue("webgl")).toBe("webgl");
  });

  it("migrates the former automatic WebGL mode to the stable renderer", () => {
    expect(normalizeTerminalRendererValue("auto")).toBe("standard");
    expect(normalizeTerminalRendererValue(undefined)).toBe("standard");
  });
});
