import { useEffect, useRef } from "react";
import { useAppStore } from "@/store";
import { matchesShortcut, parseShortcut } from "@/lib/shortcut";
import { useShortcutStore } from "@/store/slices/shortcutSlice";
import { getAppShortcut } from "@/lib/appShortcuts";
import type { ShortcutAction } from "@/constants/shortcuts";

const SETTINGS_ID = "__settings__";

interface ShortcutHandlers {
  onNewSession?: () => void;
  onToggleSidebar?: () => void;
  onGlobalTextSearch?: () => void;
  onRequestCloseTab?: (tabId: string) => void;
  onSelectAllExplorer?: () => void;
  onVoiceShortcutPress?: () => void;
  onVoiceShortcutRelease?: () => void;
  voiceShortcut?: string;
  enableVoiceShortcut?: boolean;
}

export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
  const openTabs = useAppStore((s) => s.openTabs);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const openTab = useAppStore((s) => s.openTab);
  const voiceShortcutPressedRef = useRef(false);
  const overrides = useShortcutStore((s) => s.overrides);

  useEffect(() => {
    const parsedVoiceShortcut = handlers.voiceShortcut
      ? parseShortcut(handlers.voiceShortcut)
      : null;

    function releaseVoiceShortcut() {
      if (!voiceShortcutPressedRef.current) {
        return;
      }
      voiceShortcutPressedRef.current = false;
      handlers.onVoiceShortcutRelease?.();
    }

    const globalActions: ShortcutAction[] = ["newSession", "globalTextSearch", "closeTab", "nextTab", "openSettings", "toggleSidebar"];
    const matches = (event: KeyboardEvent, action: ShortcutAction) => matchesShortcut(event, getAppShortcut(overrides, action));

    function handleKeyDown(e: KeyboardEvent) {
      if (e.isComposing || useShortcutStore.getState().recordingAction) return;
      const hasPrimaryModifier = e.ctrlKey || e.metaKey;
      const lowerKey = e.key.toLowerCase();
      const isTerminalTarget = isTerminalShortcutTarget(e.target);

      // 全局快捷键在 Monaco 编辑器中也生效
      if (!globalActions.some((action) => matches(e, action)) && shouldIgnoreShortcut(e)) {
        return;
      }

      // Ctrl+A: disable browser-style select-all in app chrome,
      // but keep native behavior inside editable fields and xterm.
      if (
        hasPrimaryModifier &&
        lowerKey === "a" &&
        !e.shiftKey &&
        !e.altKey &&
        !isTerminalTarget
      ) {
        consumeShortcut(e);
        if (isExplorerShortcutTarget(e.target)) {
          handlers.onSelectAllExplorer?.();
        }
        return;
      }

      // Ctrl+N: New session
      if (matches(e, "newSession")) {
        consumeShortcut(e);
        if (e.repeat) return;
        handlers.onNewSession?.();
        return;
      }

      // Ctrl+Shift+F: Search text across the project.
      if (matches(e, "globalTextSearch")) {
        consumeShortcut(e);
        if (e.repeat) return;
        handlers.onGlobalTextSearch?.();
        return;
      }

      // Ctrl+W: Close current tab
      if (matches(e, "closeTab")) {
        consumeShortcut(e);
        if (e.repeat) return;
        if (activeSessionId) {
          handlers.onRequestCloseTab?.(activeSessionId);
        }
        return;
      }

      // Ctrl+Tab: Switch to next tab
      if (matches(e, "nextTab")) {
        consumeShortcut(e);
        if (e.repeat) return;
        if (openTabs.length > 1) {
          const currentIndex = openTabs.indexOf(activeSessionId ?? "");
          const nextIndex = (currentIndex + 1) % openTabs.length;
          openTab(openTabs[nextIndex]);
        }
        return;
      }

      // Ctrl+,: Open settings
      if (matches(e, "openSettings")) {
        consumeShortcut(e);
        if (e.repeat) return;
        openTab(SETTINGS_ID);
        return;
      }

      // Ctrl+B: Toggle sidebar
      if (matches(e, "toggleSidebar")) {
        consumeShortcut(e);
        if (e.repeat) return;
        handlers.onToggleSidebar?.();
        return;
      }

      if (
        handlers.enableVoiceShortcut !== false &&
        handlers.voiceShortcut &&
        matchesShortcut(e, handlers.voiceShortcut)
      ) {
        consumeShortcut(e);
        if (!voiceShortcutPressedRef.current) {
          voiceShortcutPressedRef.current = true;
          handlers.onVoiceShortcutPress?.();
        }
        return;
      }
    }

    function handleKeyUp(e: KeyboardEvent) {
      if (
        handlers.enableVoiceShortcut === false ||
        !handlers.voiceShortcut ||
        !parsedVoiceShortcut ||
        !voiceShortcutPressedRef.current
      ) {
        return;
      }

      const releasedKey = e.key.toLowerCase();
      const releasedShortcutKey = releasedKey === parsedVoiceShortcut.key;
      const releasedRequiredModifier =
        (parsedVoiceShortcut.primaryKey && (releasedKey === "control" || releasedKey === "meta")) ||
        (parsedVoiceShortcut.shiftKey && releasedKey === "shift") ||
        (parsedVoiceShortcut.altKey && releasedKey === "alt");

      if (releasedShortcutKey || releasedRequiredModifier) {
        consumeShortcut(e);
        releaseVoiceShortcut();
      }
    }

    function handleWindowBlur() {
      releaseVoiceShortcut();
    }

    function handleVisibilityChange() {
      if (document.hidden) {
        releaseVoiceShortcut();
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", handleWindowBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", handleWindowBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      voiceShortcutPressedRef.current = false;
    };
  }, [openTabs, activeSessionId, openTab, handlers, overrides]);
}

export function shouldIgnoreShortcut(event: KeyboardEvent): boolean {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  // xterm uses a hidden textarea for keyboard input. Treat terminal focus as
  // terminal focus instead of a generic editable field so app-level shortcuts
  // can still work while the terminal is active.
  if (isTerminalShortcutTarget(target)) {
    return false;
  }

  if (target.closest(".monaco-editor")) {
    return true;
  }

  if (target.isContentEditable || target.closest("[contenteditable='true']")) {
    return true;
  }

  const tagName = target.tagName.toLowerCase();
  if (tagName === "input" || tagName === "textarea" || tagName === "select") {
    return true;
  }

  return false;
}

export function isTerminalShortcutTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest(".xterm");
}

function isExplorerShortcutTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest("[data-explorer-shortcuts='true']");
}

function consumeShortcut(event: KeyboardEvent) {
  event.preventDefault();
  event.stopPropagation();
}
