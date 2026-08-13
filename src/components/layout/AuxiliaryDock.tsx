import {
  CloseOutlined,
  CodeOutlined,
  FileOutlined,
  FolderOpenOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import { Empty, Input, List, Modal, Spin, message } from "antd";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentActivityIcon } from "@/components/AgentActivityIcon";
import CheckpointReviewDrawer from "@/components/CheckpointReviewDrawer";
import SessionCheckpointSummaryBar from "@/components/SessionCheckpointSummaryBar";
import { cleanupSessionProcess, searchProjectEntries } from "@/lib/api";
import {
  OPEN_AUXILIARY_FILE_EVENT,
  type OpenAuxiliaryFileDetail,
} from "@/lib/auxiliaryDock";
import { OPEN_CHECKPOINT_REVIEW_EVENT } from "@/lib/checkpointReview";
import { useAppStore } from "@/store";
import {
  clampAuxiliaryDockWidth,
  MIN_AUXILIARY_DOCK_WIDTH,
  type AuxiliaryTab,
  useAuxiliaryDockStore,
} from "@/store/auxiliaryDock";
import type { FileTreeEntry } from "@/types";

const TERMINAL_LAYOUT_SYNC_EVENT = "terminal:layout-sync";
const AuxiliaryFileView = lazy(() => import("@/components/AuxiliaryFileView"));
const Terminal = lazy(() => import("@/components/Terminal"));

interface AuxiliaryDockProps {
  onRequestTerminal: () => void;
  onRequestTask: () => void;
}

function tabIcon(kind: AuxiliaryTab["kind"]) {
  if (kind === "terminal") return <CodeOutlined />;
  if (kind === "task") return <RobotOutlined />;
  if (kind === "review") return <SafetyCertificateOutlined />;
  return <FileOutlined />;
}

export default function AuxiliaryDock({
  onRequestTerminal,
  onRequestTask,
}: AuxiliaryDockProps) {
  const { t } = useTranslation();
  const currentProject = useAppStore((state) => state.currentProject);
  const sessions = useAppStore((state) => state.sessions);
  const updateSession = useAppStore((state) => state.updateSession);
  const removeSession = useAppStore((state) => state.removeSession);
  const open = useAuxiliaryDockStore((state) => state.open);
  const width = useAuxiliaryDockStore((state) => state.width);
  const tabs = useAuxiliaryDockStore((state) => state.tabs);
  const activeTabId = useAuxiliaryDockStore((state) => state.activeTabId);
  const setWidth = useAuxiliaryDockStore((state) => state.setWidth);
  const activateTab = useAuxiliaryDockStore((state) => state.activateTab);
  const openFile = useAuxiliaryDockStore((state) => state.openFile);
  const openReview = useAuxiliaryDockStore((state) => state.openReview);
  const pinTab = useAuxiliaryDockStore((state) => state.pinTab);
  const closeTab = useAuxiliaryDockStore((state) => state.closeTab);
  const reset = useAuxiliaryDockStore((state) => state.reset);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [fileQuery, setFileQuery] = useState("");
  const [fileResults, setFileResults] = useState<FileTreeEntry[]>([]);
  const [fileSearching, setFileSearching] = useState(false);
  const [hostWidth, setHostWidth] = useState(() => window.innerWidth);
  const dockRef = useRef<HTMLElement>(null);
  const closingSessionIdsRef = useRef(new Set<string>());
  const preferredWidthRatioRef = useRef<number | null>(null);
  const previousHostWidthRef = useRef<number | null>(null);

  useEffect(() => {
    const host = dockRef.current?.parentElement;
    if (!host) return;

    const updateWidth = (nextHostWidth: number) => {
      if (nextHostWidth <= 0) return;
      setHostWidth(nextHostWidth);

      const currentWidth = useAuxiliaryDockStore.getState().width;
      if (preferredWidthRatioRef.current === null) {
        preferredWidthRatioRef.current = currentWidth / nextHostWidth;
      } else if (previousHostWidthRef.current !== null
        && Math.abs(previousHostWidthRef.current - nextHostWidth) > 0.5) {
        setWidth(preferredWidthRatioRef.current * nextHostWidth);
      }
      previousHostWidthRef.current = nextHostWidth;
    };

    updateWidth(host.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      updateWidth(entries[0]?.contentRect.width ?? host.getBoundingClientRect().width);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [setWidth]);

  useEffect(() => {
    reset();
  }, [currentProject?.path, reset]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<OpenAuxiliaryFileDetail>).detail;
      if (!detail?.projectPath || !detail.path) return;
      openFile(detail);
    };
    window.addEventListener(OPEN_AUXILIARY_FILE_EVENT, handler);
    return () => window.removeEventListener(OPEN_AUXILIARY_FILE_EVENT, handler);
  }, [openFile]);

  useEffect(() => {
    const handler = (event: Event) => {
      const sessionId = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (!sessionId || !currentProject) return;
      const session = useAppStore.getState().sessions.find((item) => item.id === sessionId);
      if (!session) return;
      openReview({
        sessionId,
        projectPath: currentProject.path,
        title: `${t("auxiliaryDock.reviewPrefix")} · ${session.name}`,
      });
    };
    window.addEventListener(OPEN_CHECKPOINT_REVIEW_EVENT, handler);
    return () => window.removeEventListener(OPEN_CHECKPOINT_REVIEW_EVENT, handler);
  }, [currentProject, openReview, t]);

  useEffect(() => {
    if (!filePickerOpen || !currentProject || !fileQuery.trim()) {
      setFileResults([]);
      setFileSearching(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setFileSearching(true);
      void searchProjectEntries(currentProject.path, fileQuery)
        .then((items) => {
          if (!cancelled) setFileResults(items.filter((item) => item.kind === "file").slice(0, 80));
        })
        .finally(() => {
          if (!cancelled) setFileSearching(false);
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [currentProject, filePickerOpen, fileQuery]);

  const syncTerminalLayouts = useCallback(() => {
    const state = useAppStore.getState();
    const sessionIds = new Set(
      useAuxiliaryDockStore.getState().tabs
        .filter((tab) => tab.kind === "terminal" || tab.kind === "task")
        .map((tab) => tab.resourceId),
    );
    if (state.activeSessionId) sessionIds.add(state.activeSessionId);
    for (const sessionId of sessionIds) {
      window.dispatchEvent(new CustomEvent(TERMINAL_LAYOUT_SYNC_EVENT, {
        detail: { sessionId, reason: "auxiliary-dock-resized" },
      }));
    }
  }, []);

  const handleResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const referenceWidth = dockRef.current?.parentElement?.getBoundingClientRect().width
      ?? hostWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (moveEvent: PointerEvent) => {
      const nextWidth = clampAuxiliaryDockWidth(startWidth + startX - moveEvent.clientX);
      preferredWidthRatioRef.current = nextWidth / referenceWidth;
      setWidth(nextWidth);
      syncTerminalLayouts();
    };
    const onEnd = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      syncTerminalLayouts();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd, { once: true });
  }, [hostWidth, setWidth, syncTerminalLayouts, width]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => syncTerminalLayouts());
    return () => window.cancelAnimationFrame(frame);
  }, [activeTabId, open, syncTerminalLayouts]);

  const handleCloseTab = useCallback(async (tab: AuxiliaryTab) => {
    if (tab.kind !== "terminal" && tab.kind !== "task") {
      closeTab(tab.id);
      return;
    }
    const session = useAppStore.getState().sessions.find((item) => item.id === tab.resourceId);
    if (!session?.active) {
      removeSession(tab.resourceId);
      closeTab(tab.id);
      return;
    }
    if (closingSessionIdsRef.current.has(tab.resourceId)) return;
    closingSessionIdsRef.current.add(tab.resourceId);
    try {
      await cleanupSessionProcess(tab.resourceId);
      removeSession(tab.resourceId);
      closeTab(tab.id);
    } catch (error) {
      void message.error(String(error));
    } finally {
      closingSessionIdsRef.current.delete(tab.resourceId);
    }
  }, [closeTab, removeSession]);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const effectiveWidth = Math.min(
    width,
    Math.max(MIN_AUXILIARY_DOCK_WIDTH, hostWidth - 24),
  );

  const resetWidth = useCallback(() => {
    const nextWidth = clampAuxiliaryDockWidth(480);
    preferredWidthRatioRef.current = nextWidth / hostWidth;
    setWidth(nextWidth);
  }, [hostWidth, setWidth]);

  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        className="app-auxiliary-divider shrink-0 cursor-col-resize"
        style={{
          display: open ? "block" : "none",
        }}
        onDoubleClick={resetWidth}
        onPointerDown={handleResizeStart}
      />
      <aside
        ref={dockRef}
        className="relative min-h-0 shrink-0 flex-col overflow-hidden"
        style={{
          display: open ? "flex" : "none",
          width: effectiveWidth,
          background: "color-mix(in srgb, var(--cs-bg-card-solid, var(--cs-bg-card)) 92%, transparent)",
        }}
      >
        {tabs.length > 0 ? (
          <div
            className="app-shell-chrome app-glass-tabbar flex min-h-9 shrink-0 items-end overflow-x-auto"
            style={{ background: "transparent" }}
          >
            {tabs.map((tab) => {
              const active = tab.id === activeTabId;
              const session = tab.kind === "terminal" || tab.kind === "task"
                ? sessions.find((item) => item.id === tab.resourceId)
                : null;
              const displayTitle = session
                ? session.name
                : tab.kind === "review"
                  ? `${t("auxiliaryDock.reviewPrefix")} · ${sessions.find((item) => item.id === tab.resourceId)?.name ?? tab.title}`
                  : tab.title;
              return (
                <div
                  key={tab.id}
                  role="tab"
                  tabIndex={active ? 0 : -1}
                  aria-selected={active}
                  data-active={active ? "true" : "false"}
                  className={`tab-item app-tab-chrome app-marker-host app-marker-bottom app-glass-tab ${active ? "app-glass-tab-active" : ""} group flex max-w-52 shrink-0 cursor-pointer items-center gap-1.5 px-3 text-xs`}
                  style={{ fontStyle: tab.preview ? "italic" : "normal" }}
                  title={displayTitle}
                  onClick={() => activateTab(tab.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      activateTab(tab.id);
                    }
                  }}
                  onDoubleClick={() => pinTab(tab.id)}
                >
                  {session ? (
                    <AgentActivityIcon
                      agentId={session.agentId ?? "claude"}
                      active={session.active}
                      status={session.status}
                      size={15}
                    />
                  ) : tabIcon(tab.kind)}
                  <span className="min-w-0 flex-1 truncate">{displayTitle}</span>
                  <button
                    type="button"
                    className="tab-close-btn ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded border-0 bg-transparent p-0 hover:bg-[var(--cs-bg-hover)]"
                    aria-label={t("common.delete")}
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleCloseTab(tab);
                    }}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    <CloseOutlined style={{ fontSize: 11 }} />
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}

        <div className="relative min-h-0 flex-1" style={{ background: "transparent" }}>
          {!activeTab ? (
            <div className="flex h-full items-center justify-center px-8">
              <div className="w-full max-w-72 space-y-1">
                <button
                  type="button"
                  className="app-auxiliary-launcher-action"
                  onClick={() => setFilePickerOpen(true)}
                >
                  <FolderOpenOutlined />
                  <span>{t("auxiliaryDock.file")}</span>
                </button>
                <button
                  type="button"
                  className="app-auxiliary-launcher-action"
                  onClick={onRequestTask}
                >
                  <RobotOutlined />
                  <span>{t("auxiliaryDock.sideTask")}</span>
                </button>
                <button
                  type="button"
                  className="app-auxiliary-launcher-action"
                  onClick={onRequestTerminal}
                >
                  <CodeOutlined />
                  <span>{t("auxiliaryDock.terminal")}</span>
                </button>
              </div>
            </div>
          ) : null}
          {tabs.map((tab) => {
            const active = tab.id === activeTabId;
            const session = sessions.find((item) => item.id === tab.resourceId) ?? null;
            return (
              <div
                key={tab.id}
                style={{ display: active ? "block" : "none", position: "absolute", inset: 0 }}
              >
                {tab.kind === "terminal" || tab.kind === "task" ? (
                  session ? (
                    <div className="flex h-full min-h-0 flex-col">
                      {tab.kind === "task" ? (
                        <SessionCheckpointSummaryBar session={session} />
                      ) : null}
                      <div className="relative min-h-0 flex-1">
                        <Suspense
                          fallback={(
                            <div className="flex h-full items-center justify-center">
                              <Spin size="small" />
                            </div>
                          )}
                        >
                          <Terminal
                            sessionId={session.id}
                            onExit={() => updateSession(session.id, { active: false })}
                            onClose={() => void handleCloseTab(tab)}
                          />
                        </Suspense>
                      </div>
                    </div>
                  ) : (
                    <Empty className="mt-16" description={t("auxiliaryDock.sessionUnavailable")} />
                  )
                ) : tab.kind === "file" ? (
                  <Suspense
                    fallback={(
                      <div className="flex h-full items-center justify-center">
                        <Spin size="small" />
                      </div>
                    )}
                  >
                    <AuxiliaryFileView
                      projectPath={tab.projectPath}
                      path={tab.resourceId}
                      preview={tab.preview}
                      onPin={() => pinTab(tab.id)}
                    />
                  </Suspense>
                ) : (
                  <CheckpointReviewDrawer
                    embedded
                    open={active}
                    projectPath={tab.projectPath}
                    session={session}
                    onClose={() => {
                      const sessionTab = tabs.find((item) =>
                        item.kind === "task" && item.resourceId === tab.resourceId,
                      ) ?? tabs.find((item) =>
                        item.kind === "terminal" && item.resourceId === tab.resourceId,
                      );
                      closeTab(tab.id, sessionTab?.id);
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </aside>

      <Modal
        open={filePickerOpen}
        title={t("auxiliaryDock.openFile")}
        footer={null}
        destroyOnHidden
        onCancel={() => setFilePickerOpen(false)}
      >
        <Input
          autoFocus
          allowClear
          value={fileQuery}
          placeholder={t("auxiliaryDock.filePlaceholder")}
          onChange={(event) => setFileQuery(event.target.value)}
        />
        <div className="mt-3 max-h-96 overflow-y-auto">
          {fileSearching ? (
            <div className="flex h-24 items-center justify-center"><Spin /></div>
          ) : !fileQuery.trim() ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("auxiliaryDock.fileHint")} />
          ) : (
            <List
              size="small"
              dataSource={fileResults}
              locale={{ emptyText: t("auxiliaryDock.noFiles") }}
              renderItem={(item) => (
                <List.Item
                  className="cursor-pointer"
                  onClick={() => {
                    if (!currentProject) return;
                    openFile({ projectPath: currentProject.path, path: item.path, preview: true });
                    setFilePickerOpen(false);
                    setFileQuery("");
                  }}
                >
                  <span className="truncate text-xs" title={item.path}>{item.path}</span>
                </List.Item>
              )}
            />
          )}
        </div>
      </Modal>
    </>
  );
}
