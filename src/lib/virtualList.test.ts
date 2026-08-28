import { describe, expect, it } from "vitest";
import { getVirtualRange } from "./virtualList";

describe("getVirtualRange", () => {
  it("returns an empty range for an empty list", () => {
    expect(getVirtualRange(0, 22, 0, 500, 8)).toEqual({ start: 0, end: 0 });
  });

  it("limits rendering to visible rows plus overscan", () => {
    expect(getVirtualRange(1_000, 22, 220, 440, 2)).toEqual({ start: 8, end: 22 });
  });

  it("clamps the range at the end of the list", () => {
    expect(getVirtualRange(10, 22, 198, 400, 3)).toEqual({ start: 6, end: 10 });
    expect(getVirtualRange(10, 22, 1_000, 1_200, 3)).toEqual({ start: 10, end: 10 });
  });
});
