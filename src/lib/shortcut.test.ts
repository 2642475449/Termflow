import { describe, expect, it } from "vitest";
import { captureShortcutFromEvent, matchesShortcut, parseShortcut, toTauriShortcut } from "./shortcut";

const eventFor = (key: string, ctrlKey = false) => ({
  key, ctrlKey, altKey: false, metaKey: false, shiftKey: false,
});

describe("single-key voice shortcuts", () => {
  it.each([["F8", "F8"], ["a", "A"], [" ", "Space"], ["Enter", "Enter"]])(
    "captures and matches %s without modifiers",
    (key, expected) => {
      const event = eventFor(key);
      expect(captureShortcutFromEvent(event)).toBe(expected);
      expect(parseShortcut(expected)?.primaryKey).toBe(false);
      expect(toTauriShortcut(expected)).toBe(expected);
      expect(matchesShortcut(event as KeyboardEvent, expected)).toBe(true);
      expect(matchesShortcut(eventFor(key, true) as KeyboardEvent, expected)).toBe(false);
    },
  );

  it("preserves combination shortcuts and waits for a key after a modifier", () => {
    expect(captureShortcutFromEvent(eventFor("Control", true))).toBeNull();
    expect(captureShortcutFromEvent(eventFor("v", true))).toBe("Ctrl+V");
    expect(toTauriShortcut("Ctrl+V")).toBe("CommandOrControl+V");
  });
});
