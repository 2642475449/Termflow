export interface ShortcutMatch {
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  primaryKey: boolean;
  key: string;
}

interface ShortcutEventLike {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  key: string;
}

const MODIFIER_ONLY_KEYS = new Set(["control", "shift", "alt", "meta"]);

function normalizeModifierToken(token: string): keyof Omit<ShortcutMatch, "key"> | null {
  switch (token.toLowerCase()) {
    case "cmd":
    case "cmdorctrl":
    case "cmdorcontrol":
    case "command":
    case "commandorcontrol":
    case "commandorctrl":
    case "control":
    case "ctrl":
      return "primaryKey";
    case "alt":
    case "option":
      return "altKey";
    case "meta":
    case "super":
    case "win":
    case "windows":
      return "metaKey";
    case "shift":
      return "shiftKey";
    default:
      return null;
  }
}

function normalizeKeyToken(token: string): string {
  const trimmed = token.trim();
  const lower = trimmed.toLowerCase();
  switch (lower) {
    case ",":
    case "comma":
      return ",";
    case ".":
    case "period":
    case "dot":
      return ".";
    case "space":
    case "spacebar":
      return " ";
    case "tab":
      return "tab";
    case "esc":
    case "escape":
      return "escape";
    case "enter":
    case "return":
      return "enter";
    case "del":
    case "delete":
      return "delete";
    case "backspace":
      return "backspace";
    case "up":
    case "arrowup":
      return "arrowup";
    case "down":
    case "arrowdown":
      return "arrowdown";
    case "left":
    case "arrowleft":
      return "arrowleft";
    case "right":
    case "arrowright":
      return "arrowright";
    default:
      return lower.length === 1 ? lower : lower;
  }
}

function normalizeEventKey(key: string): string {
  return normalizeKeyToken(key);
}

function formatDisplayKey(key: string): string {
  switch (key) {
    case ",":
      return ",";
    case ".":
      return ".";
    case " ":
      return "Space";
    case "tab":
      return "Tab";
    case "escape":
      return "Esc";
    case "enter":
      return "Enter";
    case "delete":
      return "Delete";
    case "backspace":
      return "Backspace";
    case "arrowup":
      return "Up";
    case "arrowdown":
      return "Down";
    case "arrowleft":
      return "Left";
    case "arrowright":
      return "Right";
    default:
      return key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1);
  }
}

function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /(Mac|iPhone|iPad)/i.test(navigator.platform);
}

export function parseShortcut(input: string): ShortcutMatch | null {
  const tokens = input
    .split("+")
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    return null;
  }

  const shortcut: ShortcutMatch = {
    altKey: false,
    metaKey: false,
    shiftKey: false,
    primaryKey: false,
    key: "",
  };

  for (const token of tokens) {
    const modifier = normalizeModifierToken(token);
    if (modifier) {
      shortcut[modifier] = true;
      continue;
    }

    if (shortcut.key) {
      return null;
    }
    shortcut.key = normalizeKeyToken(token);
  }

  return shortcut.key ? shortcut : null;
}

export function formatShortcutDisplay(input: string): string {
  const shortcut = parseShortcut(input);
  if (!shortcut) {
    return input.trim();
  }

  const parts: string[] = [];
  if (shortcut.primaryKey) parts.push(isMacPlatform() ? "Cmd" : "Ctrl");
  if (shortcut.metaKey) parts.push("Meta");
  if (shortcut.altKey) parts.push("Alt");
  if (shortcut.shiftKey) parts.push("Shift");
  parts.push(formatDisplayKey(shortcut.key));
  return parts.join("+");
}

export function captureShortcutFromEvent(event: ShortcutEventLike): string | null {
  const normalizedKey = normalizeEventKey(event.key);
  if (MODIFIER_ONLY_KEYS.has(normalizedKey)) {
    return null;
  }

  const parts: string[] = [];
  if (event.ctrlKey) {
    parts.push("Ctrl");
  } else if (event.metaKey) {
    parts.push(isMacPlatform() ? "Cmd" : "Meta");
  }

  if (event.ctrlKey && event.metaKey) {
    parts.push("Meta");
  }
  if (event.altKey) {
    parts.push("Alt");
  }
  if (event.shiftKey) {
    parts.push("Shift");
  }

  parts.push(formatDisplayKey(normalizedKey));
  return parts.join("+");
}

export function matchesShortcut(event: KeyboardEvent, shortcutText: string): boolean {
  const shortcut = parseShortcut(shortcutText);
  if (!shortcut) {
    return false;
  }

  const eventKey = normalizeEventKey(event.key);
  return (
    shortcut.altKey === event.altKey &&
    shortcut.metaKey === event.metaKey &&
    shortcut.shiftKey === event.shiftKey &&
    shortcut.primaryKey === (event.ctrlKey || event.metaKey) &&
    shortcut.key === eventKey
  );
}

export function toTauriShortcut(shortcutText: string): string | null {
  const shortcut = parseShortcut(shortcutText);
  if (!shortcut) {
    return null;
  }

  const parts: string[] = [];
  if (shortcut.primaryKey) parts.push("CommandOrControl");
  if (shortcut.metaKey) parts.push("Meta");
  if (shortcut.altKey) parts.push("Alt");
  if (shortcut.shiftKey) parts.push("Shift");

  const key = shortcut.key;
  if (key.length === 1 && /[a-z0-9]/i.test(key)) {
    parts.push(key.toUpperCase());
  } else if (key === ",") {
    parts.push("Comma");
  } else if (key === ".") {
    parts.push("Period");
  } else if (key === " ") {
    parts.push("Space");
  } else {
    parts.push(key[0].toUpperCase() + key.slice(1));
  }

  return parts.join("+");
}
