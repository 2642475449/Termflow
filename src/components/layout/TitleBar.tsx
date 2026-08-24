import {
  BorderOutlined,
  CloseOutlined,
  MinusOutlined,
  SwitcherOutlined,
} from "@ant-design/icons";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "@/store";
import { useCallback, useEffect, useState } from "react";
import TitleBarQuickSearch from "./TitleBarQuickSearch";
import TitleBarProjectSwitcher from "./TitleBarProjectSwitcher";
import { QuickCommandsButton } from "@/components/QuickCommandsButton";
import { ContentOverviewPopover } from "@/components/ContentOverviewPopover";
import { useAuxiliaryDockStore } from "@/store/auxiliaryDock";
import { isAiAgentId } from "@/lib/agents";
import { isSessionTurnRunning } from "@/lib/sessions";
import { Tooltip } from "antd";
import { useTranslation } from "react-i18next";

function AuxiliaryPanelGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <rect x="1.5" y="2" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
      <path d="M8.5 2.5V11.5" stroke="currentColor" strokeWidth="1.25" />
      <path d="M10.5 5V9" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

function TitleBar() {
  const { t } = useTranslation();
  const windowMode = useAppStore((s) => s.windowMode);
  const windowProject = useAppStore((s) => s.windowProject);
  const currentProject = useAppStore((s) => s.currentProject);
  const activePaneId = useAppStore((s) => s.activePaneId);
  const panesById = useAppStore((s) => s.panesById);
  const sessions = useAppStore((s) => s.sessions);
  const auxiliaryOpen = useAuxiliaryDockStore((state) => state.open);
  const toggleAuxiliary = useAuxiliaryDockStore((state) => state.toggle);
  const [isMaximized, setIsMaximized] = useState(false);
  const activeTabId = activePaneId ? panesById[activePaneId]?.activeTabId ?? null : null;
  const activeSession = activeTabId
    ? sessions.find((session) => session.id === activeTabId) ?? null
    : null;

  const titleText =
    windowMode === "project" && windowProject?.name
      ? `Termflow | ${windowProject.name}`
      : "Termflow";

  const syncMaximizedState = useCallback(async () => {
    try {
      setIsMaximized(await getCurrentWindow().isMaximized());
    } catch {
      // Ignore state sync failures so the title bar remains interactive.
    }
  }, []);

  useEffect(() => {
    getCurrentWindow().setTitle(titleText).catch(() => {});
  }, [titleText]);

  useEffect(() => {
    let disposed = false;
    let unlistenResize: undefined | (() => void);

    void syncMaximizedState();

    void getCurrentWindow()
      .onResized(() => {
        void syncMaximizedState();
      })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        unlistenResize = unlisten;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      unlistenResize?.();
    };
  }, [syncMaximizedState]);

  function handleMinimize() {
    getCurrentWindow().minimize();
  }

  async function handleMaximize() {
    try {
      await getCurrentWindow().toggleMaximize();
    } finally {
      void syncMaximizedState();
    }
  }

  function handleClose() {
    getCurrentWindow().close();
  }

  return (
    <div
      className="app-shell-chrome app-glass-toolbar h-9 flex items-center select-none"
    >
      <div className="flex-1 flex items-center h-full pl-2">
        <div className="flex shrink-0 items-center gap-2 px-2">
          <img
            src="/logo.png"
            alt="Termflow"
            className="h-4 w-4 shrink-0 rounded-[4px]"
            draggable={false}
          />
          <span
            className="text-[12px] font-semibold tracking-[0.01em]"
            style={{ color: "var(--cs-text-primary)" }}
          >
            Termflow
          </span>
        </div>
        <div
          className="mx-3 self-center"
          style={{
            width: 1,
            height: 16,
            background: "color-mix(in srgb, var(--cs-border) 54%, transparent)",
          }}
          aria-hidden="true"
        />
        <div className="shrink-0">
          <TitleBarProjectSwitcher />
        </div>
        <div
          className="mx-3 self-center"
          style={{
            width: 1,
            height: 16,
            background: "color-mix(in srgb, var(--cs-border) 54%, transparent)",
          }}
          aria-hidden="true"
        />
        <div className="shrink-0">
          <TitleBarQuickSearch />
        </div>
        <div data-tauri-drag-region className="flex-1 h-full min-w-0" />
      </div>

      {/* Right: window controls */}
      <div className="flex items-center h-full">
        {currentProject && (
          <>
            <div className="h-full shrink-0 flex items-center justify-center pl-2 pr-1">
              <QuickCommandsButton />
            </div>
            {activeSession?.agentId && isAiAgentId(activeSession.agentId) && (
              <ContentOverviewPopover
                sessionId={activeSession.id}
                navigationId={activePaneId
                  ? `${activePaneId}:${activeSession.id}`
                  : activeSession.id}
                isRunning={isSessionTurnRunning(activeSession)}
              />
            )}
            <Tooltip title={t("auxiliaryDock.toggle")}>
              <button
                type="button"
                aria-pressed={auxiliaryOpen}
                data-active={auxiliaryOpen ? "true" : "false"}
                className="app-rail-button app-marker-host app-marker-rail mr-1 flex h-8 w-10 items-center justify-center rounded-md"
                onClick={toggleAuxiliary}
              >
                <AuxiliaryPanelGlyph />
              </button>
            </Tooltip>
          </>
        )}
        <button
          className="h-full px-3 flex items-center justify-center transition-colors"
          style={{ color: "var(--cs-text-secondary)" }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--cs-bg-hover)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          onClick={handleMinimize}
        >
          <MinusOutlined className="text-xs" />
        </button>
        <button
          className="h-full px-3 flex items-center justify-center transition-colors"
          style={{ color: "var(--cs-text-secondary)" }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--cs-bg-hover)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          onClick={handleMaximize}
        >
          {isMaximized ? (
            <SwitcherOutlined className="text-xs" />
          ) : (
            <BorderOutlined className="text-xs" />
          )}
        </button>
        <button
          className="h-full px-3 flex items-center justify-center transition-colors"
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--cs-danger)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          onClick={handleClose}
        >
          <CloseOutlined className="text-xs" style={{ color: "var(--cs-text-secondary)" }} />
        </button>
      </div>
    </div>
  );
}

export default TitleBar;
