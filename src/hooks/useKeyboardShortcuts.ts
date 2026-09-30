import { useEffect, useRef } from "react";
import { useAppStore } from "@/store";
import { matchesShortcut, parseShortcut } from "@/lib/shortcut";

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

    /** 判断是否为全局应用快捷键（Ctrl+N/W/B/Tab/,），这些快捷键在 Monaco 编辑器中也应生效 */
    function isGlobalAppShortcut(e: KeyboardEvent): boolean {
      if (!e.ctrlKey && !e.metaKey) return false;
      if (e.altKey) return false;
      const key = e.key.toLowerCase();
      if (e.shiftKey) return key === "f";
      return key === "n" || key === "w" || key === "b" || key === "tab" || key === ",";
    }

    function handleKeyDown(e: KeyboardEvent) {
      const hasPrimaryModifier = e.ctrlKey || e.metaKey;
      const lowerKey = e.key.toLowerCase();
      const isTerminalTarget = isTerminalShortcutTarget(e.target);

      // 全局快捷键在 Monaco 编辑器中也生效
      if (!isGlobalAppShortcut(e) && shouldIgnoreShortcut(e)) {
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
      if (hasPrimaryModifier && lowerKey === "n" && !e.shiftKey && !e.altKey) {
        consumeShortcut(e);
        handlers.onNewSession?.();
        return;
      }

      // Ctrl+Shift+F: Search text across the project.
      if (hasPrimaryModifier && e.shiftKey && lowerKey === "f" && !e.altKey) {
        consumeShortcut(e);
        handlers.onGlobalTextSearch?.();
        return;
      }

      // Ctrl+W: Close current tab
      if (hasPrimaryModifier && lowerKey === "w" && !e.shiftKey && !e.altKey) {
        consumeShortcut(e);
        if (activeSessionId) {
          handlers.onRequestCloseTab?.(activeSessionId);
        }
        return;
      }

      // Ctrl+Tab: Switch to next tab
      if (hasPrimaryModifier && e.key === "Tab" && !e.shiftKey && !e.altKey) {
        consumeShortcut(e);
        if (openTabs.length > 1) {
          const currentIndex = openTabs.indexOf(activeSessionId ?? "");
          const nextIndex = (currentIndex + 1) % openTabs.length;
          openTab(openTabs[nextIndex]);
        }
        return;
      }

      // Ctrl+,: Open settings
      if (hasPrimaryModifier && e.key === "," && !e.shiftKey && !e.altKey) {
        consumeShortcut(e);
        openTab(SETTINGS_ID);
        return;
      }

      // Ctrl+B: Toggle sidebar
      if (hasPrimaryModifier && lowerKey === "b" && !e.shiftKey && !e.altKey) {
        consumeShortcut(e);
        handlers.onToggleSidebar?.();
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
  }, [openTabs, activeSessionId, openTab, handlers]);
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
