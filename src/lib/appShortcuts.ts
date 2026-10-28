import { SHORTCUTS, type ShortcutAction, type ShortcutOverrides } from "@/constants/shortcuts";
import { captureShortcutFromEvent, formatShortcutDisplay, parseShortcut } from "./shortcut";

export function getAppShortcut(overrides: ShortcutOverrides, action: ShortcutAction, voiceShortcut = "Ctrl+Shift+V"): string {
  if (action === "voiceInput") return voiceShortcut;
  return overrides[action] ?? SHORTCUTS.find((item) => item.id === action)?.keys ?? "";
}

function shortcutIdentity(keys: string): string {
  const parsed = parseShortcut(keys);
  return parsed ? JSON.stringify(parsed) : keys.trim().toLowerCase();
}

export function findShortcutConflict(
  overrides: ShortcutOverrides, action: ShortcutAction, keys: string, voiceShortcut: string,
): ShortcutAction | undefined {
  if (!keys) return undefined;
  return SHORTCUTS.find((item) => item.id !== action &&
    shortcutIdentity(getAppShortcut(overrides, item.id, voiceShortcut)) === shortcutIdentity(keys))?.id;
}

// 普通字符和编辑按键不能作为应用快捷键，避免吞掉终端输入。
export function isValidAppShortcut(keys: string): boolean {
  if (keys === "Double Shift") return true;
  const parsed = parseShortcut(keys);
  if (!parsed || ["unidentified", "dead", "process", "escape"].includes(parsed.key)) return false;
  if (parsed.primaryKey && !parsed.altKey && !parsed.shiftKey && !parsed.metaKey && ["a", "c", "v"].includes(parsed.key)) return false;
  return parsed.primaryKey || parsed.altKey || parsed.metaKey || /^f([1-9]|1\d|2[0-4])$/.test(parsed.key);
}

export function normalizeShortcutOverrides(value: unknown): ShortcutOverrides {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  const result: ShortcutOverrides = {};
  for (const { id } of SHORTCUTS) {
    if (id === "voiceInput") continue;
    const keys = source[id];
    if (typeof keys === "string" && (keys === "" || isValidAppShortcut(keys))) {
      result[id] = keys === "Double Shift" ? keys : formatShortcutDisplay(keys);
    }
  }
  return result;
}

export function captureAppShortcut(event: KeyboardEvent): string | null {
  if (event.isComposing || event.repeat) return null;
  return captureShortcutFromEvent(event);
}

// 双击 Shift 必须是两次独立的按下/松开，中间有其他键则重置。
export function createDoubleShiftMatcher(windowMs = 320) {
  let lastRelease: number | null = null;
  let shiftOnly = false;
  return (event: Pick<KeyboardEvent, "type" | "key" | "repeat" | "ctrlKey" | "metaKey" | "altKey">, now: number): boolean => {
    if (event.key !== "Shift" || event.ctrlKey || event.metaKey || event.altKey) {
      shiftOnly = false;
      lastRelease = null;
      return false;
    }
    if (event.repeat) return false;
    if (event.type === "keydown") {
      shiftOnly = true;
      return false;
    }
    if (!shiftOnly) return false;
    shiftOnly = false;
    const matched = lastRelease !== null && now - lastRelease <= windowMs;
    lastRelease = matched ? null : now;
    return matched;
  };
}
