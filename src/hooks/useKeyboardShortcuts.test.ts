import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ShortcutOverrides } from "@/constants/shortcuts";

const mocks = vi.hoisted(() => ({
  cleanups: [] as (() => void)[],
  app: { openTabs: ["a", "b"], activeSessionId: "a", openTab: vi.fn() },
  shortcuts: { overrides: {} as ShortcutOverrides, recordingAction: null as string | null },
}));
vi.mock("react", () => ({
  useRef: (current: unknown) => ({ current }),
  useEffect: (effect: () => () => void) => { mocks.cleanups.push(effect()); },
}));
vi.mock("@/store", () => ({ useAppStore: (select: (state: typeof mocks.app) => unknown) => select(mocks.app) }));
vi.mock("@/store/slices/shortcutSlice", () => ({
  useShortcutStore: Object.assign((select: (state: typeof mocks.shortcuts) => unknown) => select(mocks.shortcuts), {
    getState: () => mocks.shortcuts,
  }),
}));
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";

function press(key: string, modifiers = {}) {
  const event = new Event("keydown", { cancelable: true });
  Object.assign(event, { key, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, repeat: false, ...modifiers });
  document.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("document", new EventTarget());
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("HTMLElement", class {});
  mocks.shortcuts.overrides = {};
  mocks.shortcuts.recordingAction = null;
});
afterEach(() => {
  mocks.cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
});

it("uses a replacement binding, disables the old key, and ignores key repeat", () => {
  mocks.shortcuts.overrides = { newSession: "Ctrl+Alt+N" };
  const onNewSession = vi.fn();
  useKeyboardShortcuts({ onNewSession });
  expect(press("n").defaultPrevented).toBe(false);
  expect(press("n", { altKey: true }).defaultPrevented).toBe(true);
  press("n", { altKey: true, repeat: true });
  expect(onNewSession).toHaveBeenCalledTimes(1);
});

it("does not dispatch disabled bindings or execute actions during recording and composition", () => {
  mocks.shortcuts.overrides = { closeTab: "" };
  const onRequestCloseTab = vi.fn();
  const onNewSession = vi.fn();
  useKeyboardShortcuts({ onRequestCloseTab, onNewSession });
  press("w");
  press("n", { isComposing: true });
  mocks.shortcuts.recordingAction = "newSession";
  press("n");
  expect(onRequestCloseTab).not.toHaveBeenCalled();
  expect(onNewSession).not.toHaveBeenCalled();
});

it("keeps tab navigation and settings actions working with custom function keys", () => {
  mocks.shortcuts.overrides = { nextTab: "F6", openSettings: "F7" };
  useKeyboardShortcuts({});
  press("F6", { ctrlKey: false });
  expect(mocks.app.openTab).toHaveBeenLastCalledWith("b");
  press("F7", { ctrlKey: false });
  expect(mocks.app.openTab).toHaveBeenLastCalledWith("__settings__");
});
