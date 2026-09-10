import { expect, it } from "vitest";
import { getGitPrimaryAction } from "./gitPrimaryAction";

it.each([
  [true, true, 3, 2, "commit"], [true, false, 0, 0, "commit"],
  [false, true, 3, 0, "push"], [false, true, 0, 2, "pull"],
  [false, true, 3, 2, "sync"], [false, true, 0, 0, "none"],
  [false, false, 3, 2, "none"],
] as const)("selects the primary action for %s / %s / %i / %i", (hasLocalChanges, remoteReady, ahead, behind, expected) => {
  expect(getGitPrimaryAction({ hasLocalChanges, remoteReady, ahead, behind })).toBe(expected);
});
