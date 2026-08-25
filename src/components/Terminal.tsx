import { useEffect, useRef, useCallback, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import { Dropdown, Modal, message } from "antd";
import type { MenuProps } from "antd";
import {
  CopyOutlined,
  SnippetsOutlined,
  SelectOutlined,
  DeleteOutlined,
  FolderOpenFilled,
  MessageOutlined,
  CloseOutlined,
} from "@ant-design/icons";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
  ptyInput,
  ptyResize,
  openInFileManager,
  submitAgentTurnInput,
  saveClipboardImage,
  inspectProjectFile,
  resolveProjectLink,
  inspectAgentClis,
  readImagePreview,
} from "@/lib/api";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  FilePathLinkProvider,
  resolveTerminalFilePath,
  type ParsedPath,
} from "@/components/terminal/FilePathLinkProvider";
import {
  consumeTerminalTitleInput,
  sanitizeSessionTitle,
} from "@/components/terminalTitle";
import { useAppStore, type TerminalRenderer } from "@/store";
import { revealExplorerPath } from "@/lib/explorer";
import { openAuxiliaryFile, openAuxiliaryQuestion } from "@/lib/auxiliaryDock";
import {
  buildSideQuestionPrompt,
  sanitizeTerminalSelection,
  type SanitizedTerminalSelection,
} from "@/lib/sideQuestion";
import {
  containsTerminalInterrupt,
  consumeTerminalSubmissionInput,
  hasTerminalPromptText,
} from "@/lib/terminalSubmission";
import { AgentIcon } from "@/components/AgentIcon";
import {
  beginContentOverviewTurn,
  registerContentOverviewNavigator,
  registerContentOverviewOutputSource,
} from "@/lib/contentOverview";
import { SideQuestionComposer } from "@/components/SideQuestionComposer";
import { getAgentDisplayName, getAgentTerminalBehavior, isAiAgentId } from "@/lib/agents";
import { isSessionTurnRunning } from "@/lib/sessions";
import { getTerminalTheme } from "@/lib/terminalTheme";
import { createPtyResizeGate } from "@/lib/terminalResize";
import type { AgentCliInfo } from "@/types";
import { useTranslation } from "react-i18next";
import "@xterm/xterm/css/xterm.css";

const TERMINAL_LAYOUT_SYNC_EVENT = "terminal:layout-sync";
const AGENT_FILE_DRAG_MIME = "application/x-termflow-agent-files";
const TERMINAL_FOCUS_RETRY_DELAYS_MS = [0, 50, 150, 300];
const TERMINAL_SCROLLBAR_INTERACTION_WIDTH = 8;
const TERMINAL_SCROLLBAR_HIDE_DELAY_MS = 700;
const HIDE_CURSOR_SEQUENCE = "\x1b[?25l";
const SHOW_CURSOR_SEQUENCE = "\x1b[?25h";
let cachedWebglSupport: boolean | null = null;

export function keepRunningCursorHidden(data: string, shouldHideCursor: boolean): string {
  return shouldHideCursor ? `${data}${HIDE_CURSOR_SEQUENCE}` : data;
}

export function shouldHideRunningAgentCursor(
  agentId: unknown,
  isTurnRunning: boolean,
): boolean {
  return isAiAgentId(agentId) && isTurnRunning;
}

function canUseWebglRenderer(): boolean {
  if (cachedWebglSupport !== null) {
    return cachedWebglSupport;
  }
  if (
    typeof document === "undefined" ||
    typeof window === "undefined" ||
    typeof WebGL2RenderingContext === "undefined"
  ) {
    cachedWebglSupport = false;
    return cachedWebglSupport;
  }

  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2", {
      antialias: false,
      depth: false,
      preserveDrawingBuffer: false,
      stencil: false,
      powerPreference: "high-performance",
    });
    cachedWebglSupport = Boolean(context);
  } catch {
    cachedWebglSupport = false;
  }

  return cachedWebglSupport;
}

function shouldAttemptWebgl(renderer: TerminalRenderer): boolean {
  if (renderer !== "webgl") {
    return false;
  }
  return canUseWebglRenderer();
}

interface TerminalProps {
  sessionId: string;
  overviewNavigationId?: string;
  onExit?: () => void;
  onClose?: () => void;
}

type AgentFileDropEntry = {
  path: string;
  kind: "file" | "directory";
  name?: string;
};

type AgentFileDropPayload = {
  type: "termflow-agent-files";
  projectPath: string;
  entries: AgentFileDropEntry[];
};

interface SideQuestionDraft {
  agent: AgentCliInfo;
  context: SanitizedTerminalSelection;
  sourceSessionName: string;
  projectPath: string;
}

type PendingTerminalLink =
  | { kind: "external"; href: string }
  | { kind: "project"; path: ParsedPath };

interface TerminalImagePreview {
  src: string;
  alt: string;
  x: number;
  y: number;
}

interface TerminalPastedImagePreview {
  src: string;
  alt: string;
  insertedText: string;
}

const IMAGE_REFERENCE_PATTERN = /\.(?:png|jpe?g|gif|webp|bmp|svg|avif)(?:$|[?#])/i;

function isImageReference(value: string): boolean {
  return IMAGE_REFERENCE_PATTERN.test(value.trim());
}

export function normalizeDecscusrCursorStyle(param: number | undefined): {
  cursorBlink: boolean;
  cursorStyle: "block" | "underline" | "bar";
} | null {
  switch (param) {
    case undefined:
    case 0:
    case 1:
    case 2:
      return { cursorBlink: false, cursorStyle: "block" };
    case 3:
    case 4:
      return { cursorBlink: false, cursorStyle: "underline" };
    case 5:
    case 6:
      return { cursorBlink: false, cursorStyle: "bar" };
    default:
      return null;
  }
}

function Terminal({ sessionId, overviewNavigationId, onExit, onClose }: TerminalProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const onExitRef = useRef(onExit);
  const onCloseRef = useRef(onClose);
  const lastPasteTriggerAtRef = useRef(0);
  const pendingTitleInputRef = useRef("");
  const pendingTitleEscapeSequenceRef = useRef("");
  const pendingSubmissionInputRef = useRef("");
  const pendingSubmissionEscapeSequenceRef = useRef("");
  const titleRequestStartedRef = useRef(false);
  const sideQuestionSubmittingRef = useRef(false);
  const hideCursorWhileRunningRef = useRef(false);
  const suppressedFocusSequenceUntilRef = useRef(0);
  const processedResourceDropStartedAtRef = useRef<number | null>(null);
  const [isImageDragOver, setIsImageDragOver] = useState(false);
  const [isAgentFileDragOver, setIsAgentFileDragOver] = useState(false);
  const [contextMenuSelection, setContextMenuSelection] = useState("");
  const [installedAgents, setInstalledAgents] = useState<AgentCliInfo[]>([]);
  const [sideQuestionDraft, setSideQuestionDraft] = useState<SideQuestionDraft | null>(null);
  const [sideQuestionText, setSideQuestionText] = useState("");
  const [pendingTerminalLink, setPendingTerminalLink] = useState<PendingTerminalLink | null>(null);
  const [imagePreview, setImagePreview] = useState<TerminalImagePreview | null>(null);
  const [pastedImagePreview, setPastedImagePreview] = useState<TerminalPastedImagePreview | null>(null);
  const [pastedImageDialogOpen, setPastedImageDialogOpen] = useState(false);
  const [openingTerminalLink, setOpeningTerminalLink] = useState(false);
  const openingTerminalLinkRef = useRef(false);
  const captureInputForAutoTitleRef = useRef<((data: string) => void) | undefined>(undefined);
  const isDropPositionInsideTerminalRef = useRef<((position: { x: number; y: number }) => boolean) | undefined>(undefined);
  const currentSessionPathRef = useRef("");
  const imagePreviewRequestRef = useRef(0);
  const imagePreviewDismissTimerRef = useRef<number | null>(null);

  const activeTheme = useAppStore((s) => s.activeTheme());
  const fontSize = useAppStore((s) => s.terminalFontSize);
  const cursorBlink = useAppStore((s) => s.terminalCursorBlink);
  const lineHeight = useAppStore((s) => s.terminalLineHeight);
  const terminalScrollback = useRef(useAppStore.getState().terminalScrollback).current;
  const terminalRenderer = useAppStore((s) => s.terminalRenderer);
  const resourceDragState = useAppStore((s) => s.resourceDragState);
  const setResourceDragState = useAppStore((s) => s.setResourceDragState);
  const updateSession = useAppStore((s) => s.updateSession);
  const openFileTab = useAppStore((s) => s.openFileTab);
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed);
  const setActiveSidebarSection = useAppStore((s) => s.setActiveSidebarSection);
  const currentSession = useAppStore((s) =>
    s.sessions.find((session) => session.id === sessionId)
  );
  const terminalBehavior = getAgentTerminalBehavior(currentSession?.agentId);
  const forceStableCursor = terminalBehavior.forceStableCursor === true;
  const manageAgentCursorVisibility = isAiAgentId(currentSession?.agentId);
  const hideCursorWhileRunning = shouldHideRunningAgentCursor(
    currentSession?.agentId,
    Boolean(currentSession && isSessionTurnRunning(currentSession)),
  );
  hideCursorWhileRunningRef.current = hideCursorWhileRunning;
  const termTheme = getTerminalTheme(activeTheme);
  const currentSessionPath = currentSession?.path ?? "";

  const pasteIntoTerminal = useCallback(async (term: XTerm | null) => {
    const pastedImage = await pasteClipboardIntoTerminal(sessionId, term, t);
    if (!pastedImage) return;

    const submissionCapture = consumeTerminalSubmissionInput(
      pendingSubmissionInputRef.current,
      pastedImage.insertedText,
      pendingSubmissionEscapeSequenceRef.current,
    );
    pendingSubmissionInputRef.current = submissionCapture.nextValue;
    pendingSubmissionEscapeSequenceRef.current = submissionCapture.pendingSequence;
    captureInputForAutoTitleRef.current?.(pastedImage.insertedText);
    setPastedImagePreview(pastedImage);
    setPastedImageDialogOpen(false);
  }, [sessionId, t]);

  useEffect(() => {
    setPastedImagePreview(null);
    setPastedImageDialogOpen(false);
  }, [sessionId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let hideTimer: number | null = null;
    const revealScrollbar = () => {
      container.dataset.scrollbarActive = "true";
      if (hideTimer !== null) {
        window.clearTimeout(hideTimer);
      }
      hideTimer = window.setTimeout(() => {
        delete container.dataset.scrollbarActive;
        hideTimer = null;
      }, TERMINAL_SCROLLBAR_HIDE_DELAY_MS);
    };

    container.addEventListener("wheel", revealScrollbar, { passive: true, capture: true });
    return () => {
      container.removeEventListener("wheel", revealScrollbar, true);
      if (hideTimer !== null) {
        window.clearTimeout(hideTimer);
      }
      delete container.dataset.scrollbarActive;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    void inspectAgentClis()
      .then((agents) => {
        if (!disposed) setInstalledAgents(agents.filter((agent) => agent.installed));
      })
      .catch((error) => {
        console.warn("Failed to inspect agents for terminal context menu:", error);
        if (!disposed) setInstalledAgents([]);
      });
    return () => {
      disposed = true;
    };
  }, []);

  const commitAutoTitle = useCallback(() => {
    if (
      !currentSession ||
      currentSession.titleSource === "manual" ||
      currentSession.firstPromptTitle ||
      titleRequestStartedRef.current
    ) {
      pendingTitleInputRef.current = "";
      pendingTitleEscapeSequenceRef.current = "";
      return;
    }

    const prompt = pendingTitleInputRef.current;
    pendingTitleInputRef.current = "";
    pendingTitleEscapeSequenceRef.current = "";
    const fallbackTitle = sanitizeSessionTitle(prompt);
    if (!fallbackTitle) return;

    titleRequestStartedRef.current = true;

    updateSession(sessionId, {
      name: fallbackTitle,
      firstPromptTitle: fallbackTitle,
      titleSource: "auto",
    });
  }, [currentSession, sessionId, updateSession]);

  const captureInputForAutoTitle = useCallback(
    (data: string) => {
      if (
        !currentSession ||
        currentSession.titleSource === "manual" ||
        currentSession.firstPromptTitle ||
        titleRequestStartedRef.current
      ) {
        return;
      }

      const result = consumeTerminalTitleInput(
        pendingTitleInputRef.current,
        data,
        pendingTitleEscapeSequenceRef.current
      );

      pendingTitleInputRef.current = result.nextValue;
      pendingTitleEscapeSequenceRef.current = result.pendingSequence;

      if (result.shouldCommit) {
        commitAutoTitle();
      }
    },
    [commitAutoTitle, currentSession]
  );

  const contextMenuItems: MenuProps["items"] = [
    {
      key: "copy",
      label: t("terminal.copy"),
      icon: <CopyOutlined />,
      disabled: !contextMenuSelection,
    },
    {
      key: "paste",
      label: t("terminal.paste"),
      icon: <SnippetsOutlined />,
    },
    {
      key: "select-all",
      label: t("terminal.selectAll"),
      icon: <SelectOutlined />,
    },
    { type: "divider" },
    {
      key: "ask-in-sidebar",
      label: t("terminal.askInSidebar"),
      icon: <MessageOutlined />,
      disabled: !contextMenuSelection || installedAgents.length === 0,
      children: installedAgents.map((agent) => ({
        key: `ask-in-sidebar:${agent.id}`,
        label: agent.name,
        icon: <AgentIcon agentId={agent.id} size={15} />,
      })),
    },
    { type: "divider" },
    {
      key: "clear-input",
      label: t("terminal.clearInput"),
      icon: <DeleteOutlined />,
      extra: "Ctrl+L",
    },
    {
      key: "open-folder",
      label: t("common.openInFileManager"),
      icon: <FolderOpenFilled />,
    },
  ];

  useEffect(() => {
    pendingTitleInputRef.current = "";
    pendingTitleEscapeSequenceRef.current = "";
    titleRequestStartedRef.current = false;
  }, [sessionId]);

  const handleContextMenuClick = useCallback(
    async (key: string) => {
      const term = terminalRef.current;
      if (key.startsWith("ask-in-sidebar:")) {
        const agentId = key.slice("ask-in-sidebar:".length);
        const agent = installedAgents.find((item) => item.id === agentId);
        const context = sanitizeTerminalSelection(contextMenuSelection);
        if (!agent || !currentSession || !context.text) return;
        sideQuestionSubmittingRef.current = false;
        setSideQuestionText("");
        setSideQuestionDraft({
          agent,
          context,
          sourceSessionName: currentSession.name,
          projectPath: currentSession.path,
        });
        return;
      }
      switch (key) {
        case "copy":
          if (contextMenuSelection) {
            await navigator.clipboard.writeText(contextMenuSelection).catch(() => {});
          }
          break;
        case "paste":
          await pasteIntoTerminal(term);
          break;
        case "select-all":
          term?.selectAll();
          break;
        case "clear-input":
          ptyInput(sessionId, "\x15").catch(console.error);
          break;
        case "open-folder":
          if (currentSessionPathRef.current) {
            openInFileManager(currentSessionPathRef.current).catch(() =>
              message.error(t("terminal.openFolderFailed"))
            );
          }
          break;
      }
    },
    [contextMenuSelection, currentSession, installedAgents, pasteIntoTerminal, sessionId, t]
  );

  const closeSideQuestionComposer = useCallback(() => {
    setSideQuestionDraft(null);
    setSideQuestionText("");
  }, []);

  const handleSideQuestionSubmit = useCallback(() => {
    if (sideQuestionSubmittingRef.current) return;
    const draft = sideQuestionDraft;
    const question = sideQuestionText.trim();
    if (!draft || !question) return;

    const launch = () => {
      if (sideQuestionSubmittingRef.current) return;
      sideQuestionSubmittingRef.current = true;
      if (draft.context.truncated) {
        void message.info(t("terminal.sideQuestionTruncated"));
      }
      openAuxiliaryQuestion({
        projectPath: draft.projectPath,
        agent: draft.agent,
        question,
        prompt: buildSideQuestionPrompt({
          question,
          context: draft.context.text,
          sourceSessionName: draft.sourceSessionName,
          projectPath: draft.projectPath,
        }),
      });
      closeSideQuestionComposer();
    };

    if (draft.context.potentialSecret) {
      Modal.confirm({
        title: t("terminal.sensitiveSideQuestionTitle"),
        content: t("terminal.sensitiveSideQuestionContent"),
        okText: t("terminal.sendToAgent"),
        cancelText: t("common.cancel"),
        onOk: launch,
      });
      return;
    }

    launch();
  }, [closeSideQuestionComposer, sideQuestionDraft, sideQuestionText, t]);

  const handleContextMenuOpenChange = useCallback((open: boolean) => {
    if (!open) return;
    const term = terminalRef.current;
    setContextMenuSelection(term?.hasSelection() ? term.getSelection() : "");
  }, []);

  const openTerminalLink = useCallback(async (link: PendingTerminalLink) => {
    if (openingTerminalLinkRef.current) return;

    openingTerminalLinkRef.current = true;
    setOpeningTerminalLink(true);
    try {
      if (link.kind === "external") {
        await openUrl(link.href);
        return;
      }

      const projectPath = currentSessionPathRef.current;
      if (!projectPath) return;

      const resolvedPath = resolveTerminalFilePath(link.path.filePath, projectPath);
      const target = await resolveProjectLink(projectPath, resolvedPath);
      if (!target) return;

      if (target.kind === "directory") {
        setSidebarCollapsed(false);
        setActiveSidebarSection("project");
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => revealExplorerPath(target.path, "directory"));
        });
        return;
      }

      const file = await inspectProjectFile(projectPath, target.path);
      if (/\.(md|markdown|pdf)$/i.test(file.path)) {
        openAuxiliaryFile({
          projectPath,
          path: file.path,
          preview: true,
        });
        return;
      }
      openFileTab(file.path, { preview: false });
    } catch {
      const path = link.kind === "project" ? link.path.filePath : link.href;
      message.error(
        link.kind === "project"
          ? t("terminal.openLinkedFileFailed", { path })
          : t("terminal.openLinkFailed", { path }),
      );
    } finally {
      openingTerminalLinkRef.current = false;
      setOpeningTerminalLink(false);
    }
  }, [openFileTab, setActiveSidebarSection, setSidebarCollapsed, t]);

  const handleConfirmTerminalLinkOpen = useCallback(async () => {
    if (!pendingTerminalLink || openingTerminalLink) return;

    await openTerminalLink(pendingTerminalLink);
    setPendingTerminalLink(null);
  }, [openTerminalLink, openingTerminalLink, pendingTerminalLink]);

  const isDropPositionInsideTerminal = useCallback((position: { x: number; y: number }) => {
    const container = containerRef.current;
    if (!container) return false;
    // 将物理像素转换为 CSS 像素
    const cssX = position.x / window.devicePixelRatio;
    const cssY = position.y / window.devicePixelRatio;
    const rect = container.getBoundingClientRect();
    return (
      cssX >= rect.left &&
      cssX <= rect.right &&
      cssY >= rect.top &&
      cssY <= rect.bottom
    );
  }, []);

  const isClientPointInsideTerminal = useCallback((position: { x: number; y: number }) => {
    const container = containerRef.current;
    if (!container) return false;
    const rect = container.getBoundingClientRect();
    return (
      position.x >= rect.left &&
      position.x <= rect.right &&
      position.y >= rect.top &&
      position.y <= rect.bottom
    );
  }, []);

  const handleAgentFileDragEnter = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasAgentFileDragPayload(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsAgentFileDragOver(true);
  }, []);

  const handleAgentFileDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasAgentFileDragPayload(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsAgentFileDragOver(true);
  }, []);

  const handleAgentFileDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
      return;
    }
    setIsAgentFileDragOver(false);
  }, []);

  const handleAgentFileDrop = useCallback(
    async (event: ReactDragEvent<HTMLDivElement>) => {
      const payload = readAgentFileDragPayload(event.dataTransfer);
      if (!payload || payload.entries.length === 0) return;

      event.preventDefault();
      event.stopPropagation();
      setIsAgentFileDragOver(false);

      const agentId = currentSession?.agentId;
      const hasDirectory = payload.entries.some((entry) => entry.kind === "directory");
      if (agentId === "antigravity" && hasDirectory) {
        const confirmed = await confirmAntigravityDirectoryDrop(t);
        if (!confirmed) return;
      }

      const text = buildAgentFileReferencePrompt({
        agentId,
        projectPath: payload.projectPath,
        entries: payload.entries,
      });
      if (!text) return;

      await ptyInput(sessionId, text);
      message.success(t("terminal.agentFilesInserted", { count: payload.entries.length }));
    },
    [currentSession?.agentId, sessionId, t]
  );

  const insertAgentFileReferences = useCallback(
    async (payload: Pick<AgentFileDropPayload, "projectPath" | "entries">) => {
      const agentId = currentSession?.agentId;
      const hasDirectory = payload.entries.some((entry) => entry.kind === "directory");
      if (agentId === "antigravity" && hasDirectory) {
        const confirmed = await confirmAntigravityDirectoryDrop(t);
        if (!confirmed) return;
      }

      const text = buildAgentFileReferencePrompt({
        agentId,
        projectPath: payload.projectPath,
        entries: payload.entries,
      });
      if (!text) return;

      await ptyInput(sessionId, text);
      message.success(t("terminal.agentFilesInserted", { count: payload.entries.length }));
    },
    [currentSession?.agentId, sessionId, t]
  );

  useEffect(() => {
    if (!resourceDragState || resourceDragState.type !== "agent-resource") {
      setIsAgentFileDragOver(false);
      processedResourceDropStartedAtRef.current = null;
      return;
    }

    const insideTerminal = isClientPointInsideTerminal({
      x: resourceDragState.x,
      y: resourceDragState.y,
    });

    if (resourceDragState.phase === "dragging") {
      setIsAgentFileDragOver(insideTerminal);
      return;
    }

    setIsAgentFileDragOver(false);
    if (!insideTerminal || processedResourceDropStartedAtRef.current === resourceDragState.startedAt) {
      return;
    }

    processedResourceDropStartedAtRef.current = resourceDragState.startedAt;
    setResourceDragState(null);
    void insertAgentFileReferences({
      projectPath: resourceDragState.projectPath,
      entries: resourceDragState.entries,
    });
  }, [
    insertAgentFileReferences,
    isClientPointInsideTerminal,
    resourceDragState,
    setResourceDragState,
  ]);

  // Keep refs in sync with latest props
  onExitRef.current = onExit;
  onCloseRef.current = onClose;
  captureInputForAutoTitleRef.current = captureInputForAutoTitle;
  isDropPositionInsideTerminalRef.current = isDropPositionInsideTerminal;
  currentSessionPathRef.current = currentSessionPath;

  const cancelImagePreviewDismissal = useCallback(() => {
    if (imagePreviewDismissTimerRef.current !== null) {
      window.clearTimeout(imagePreviewDismissTimerRef.current);
      imagePreviewDismissTimerRef.current = null;
    }
  }, []);

  const hideImagePreview = useCallback(() => {
    cancelImagePreviewDismissal();
    imagePreviewRequestRef.current += 1;
    setImagePreview(null);
  }, [cancelImagePreviewDismissal]);

  const scheduleImagePreviewDismissal = useCallback(() => {
    cancelImagePreviewDismissal();
    imagePreviewDismissTimerRef.current = window.setTimeout(hideImagePreview, 120);
  }, [cancelImagePreviewDismissal, hideImagePreview]);

  const previewPosition = useCallback((event: MouseEvent) => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) return null;
    return {
      x: Math.max(8, Math.min(event.clientX - bounds.left + 14, bounds.width - 328)),
      y: Math.max(8, Math.min(event.clientY - bounds.top + 14, bounds.height - 248)),
    };
  }, []);

  const showLocalImagePreview = useCallback((path: ParsedPath, event: MouseEvent) => {
    if (!isImageReference(path.filePath)) return;
    const position = previewPosition(event);
    if (!position) return;
    cancelImagePreviewDismissal();
    const requestId = imagePreviewRequestRef.current + 1;
    imagePreviewRequestRef.current = requestId;
    void readImagePreview(resolveTerminalFilePath(path.filePath, currentSessionPathRef.current))
      .then(({ dataUrl }) => {
        if (imagePreviewRequestRef.current === requestId) {
          setImagePreview({ src: dataUrl, alt: path.filePath, ...position });
        }
      })
      .catch(() => {
        if (imagePreviewRequestRef.current === requestId) setImagePreview(null);
      });
  }, [cancelImagePreviewDismissal, previewPosition]);

  const showExternalImagePreview = useCallback((url: string, event: MouseEvent) => {
    if (!isImageReference(url)) return;
    const position = previewPosition(event);
    if (!position) return;
    cancelImagePreviewDismissal();
    imagePreviewRequestRef.current += 1;
    setImagePreview({ src: url, alt: url, ...position });
  }, [cancelImagePreviewDismissal, previewPosition]);

  useEffect(() => () => cancelImagePreviewDismissal(), [cancelImagePreviewDismissal]);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace",
      fontSize,
      lineHeight,
      theme: termTheme.theme,
      minimumContrastRatio: termTheme.minimumContrastRatio,
      cursorBlink: forceStableCursor ? false : cursorBlink,
      scrollback: terminalScrollback,
      overviewRuler: { width: TERMINAL_SCROLLBAR_INTERACTION_WIDTH },
      convertEol: true,
      disableStdin: !currentSession?.active || currentSession?.status === "starting",
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    // URL 链接：单击后先确认，再使用 Tauri 原生方式打开系统浏览器。
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (event.button !== 0) return;
        setPendingTerminalLink({ kind: "external", href: uri });
      }, {
        hover: (event, uri) => showExternalImagePreview(uri, event),
        leave: scheduleImagePreviewDismissal,
      }),
    );

    // 文件和目录路径会先在项目根目录内做存在性校验，确认后才显示为链接。
    const LINK_TARGET_CACHE_TTL_MS = 5_000;
    const MAX_LINK_TARGET_CACHE_SIZE = 256;
    const linkTargetCache = new Map<string, {
      expiresAt: number;
      result: Promise<{ path: string; kind: "file" | "directory" } | null>;
    }>();
    const getLinkedTarget = (parsed: { filePath: string }) => {
      const projectPath = currentSessionPathRef.current;
      if (!projectPath) return Promise.resolve(null);

      const resolvedPath = resolveTerminalFilePath(parsed.filePath, projectPath);
      const cacheKey = `${projectPath}\u0000${resolvedPath}`;
      const cached = linkTargetCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        linkTargetCache.delete(cacheKey);
        linkTargetCache.set(cacheKey, cached);
        return cached.result;
      }

      if (linkTargetCache.size >= MAX_LINK_TARGET_CACHE_SIZE) {
        const oldestCacheKey = linkTargetCache.keys().next().value;
        if (oldestCacheKey) linkTargetCache.delete(oldestCacheKey);
      }

      const result = resolveProjectLink(projectPath, resolvedPath).catch(() => null);
      linkTargetCache.set(cacheKey, {
        expiresAt: Date.now() + LINK_TARGET_CACHE_TTL_MS,
        result,
      });
      return result;
    };
    const filePathProvider = new FilePathLinkProvider(
      term,
      (parsed, openDirectly) => {
        const link = { kind: "project" as const, path: parsed };
        return openDirectly
          ? openTerminalLink(link)
          : setPendingTerminalLink(link);
      },
      async (parsed) => isImageReference(parsed.filePath) || (await getLinkedTarget(parsed)) !== null,
      showLocalImagePreview,
      scheduleImagePreviewDismissal,
    );
    const filePathDisposable = term.registerLinkProvider(filePathProvider);
    term.open(containerRef.current);
    terminalRef.current = term;
    const unregisterOverviewNavigator = registerContentOverviewNavigator(
      overviewNavigationId ?? sessionId,
      (anchorText) => {
        const normalizedAnchor = anchorText.replace(/\s+/g, " ").trim().toLocaleLowerCase();
        if (!normalizedAnchor) return false;
        const buffer = term.buffer.active;
        for (let lineIndex = 0; lineIndex < buffer.length; lineIndex += 1) {
          const line = buffer.getLine(lineIndex)?.translateToString(true)
            .replace(/\s+/g, " ")
            .trim()
            .toLocaleLowerCase();
          if (line?.includes(normalizedAnchor)) {
            term.scrollToLine(Math.max(0, lineIndex - 1));
            return true;
          }
        }
        return false;
      },
    );
    const overviewOutputSource = registerContentOverviewOutputSource(sessionId);

    const cursorStyleDisposable = forceStableCursor
      ? term.parser.registerCsiHandler({ intermediates: " ", final: "q" }, (params) => {
          const firstParam = Array.isArray(params[0]) ? params[0][0] : params[0];
          const cursorOptions = normalizeDecscusrCursorStyle(firstParam);
          if (!cursorOptions) return false;
          term.options.cursorBlink = false;
          term.options.cursorStyle = cursorOptions.cursorStyle;
          return true;
        })
      : null;

    let webglAddon: WebglAddon | null = null;
    let webglContextLossListener: { dispose(): void } | null = null;
    let fallbackAnimationFrame: number | null = null;
    let isTerminalDisposed = false;

    const disposeWebglAddon = () => {
      webglContextLossListener?.dispose();
      webglContextLossListener = null;
      webglAddon?.dispose();
      webglAddon = null;
    };

    const fallbackToStandardRenderer = (reason: string, error?: unknown) => {
      if (error) {
        console.warn(`[terminal:${sessionId}] WebGL renderer fallback (${reason})`, error);
      } else {
        console.warn(`[terminal:${sessionId}] WebGL renderer fallback (${reason})`);
      }
      disposeWebglAddon();
      if (fallbackAnimationFrame !== null) {
        window.cancelAnimationFrame(fallbackAnimationFrame);
      }
      fallbackAnimationFrame = window.requestAnimationFrame(() => {
        fallbackAnimationFrame = null;
        if (
          isTerminalDisposed ||
          terminalRef.current !== term ||
          !containerRef.current ||
          containerRef.current.clientWidth === 0
        ) {
          return;
        }
        fitAddon.fit();
        ptyResize(sessionId, term.rows, term.cols).catch(console.error);
        term.refresh(0, term.rows - 1);
      });
    };

    const activateWebglRenderer = () => {
      if (!shouldAttemptWebgl(terminalRenderer)) {
        if (terminalRenderer === "webgl") {
          console.warn(`[terminal:${sessionId}] WebGL renderer unavailable, using standard renderer`);
        }
        return;
      }

      try {
        const addon = new WebglAddon();
        const contextLossListener = addon.onContextLoss(() => {
          fallbackToStandardRenderer("context-loss");
        });
        term.loadAddon(addon);
        webglAddon = addon;
        webglContextLossListener = contextLossListener;
      } catch (error) {
        fallbackToStandardRenderer("activation-failed", error);
      }
    };

    activateWebglRenderer();

    let queuedInputOperations = 0;
    let inputQueue: Promise<void> = Promise.resolve();
    const enqueueInput = (operation: () => Promise<void>) => {
      queuedInputOperations += 1;
      inputQueue = inputQueue
        .then(operation, operation)
        .finally(() => {
          queuedInputOperations -= 1;
        });
    };

    // Send user input to PTY as-is. Control keys like Backspace may repeat rapidly,
    // so deduplicating identical payloads here will make deletion feel laggy.
    term.onData((data) => {
      // xterm may emit focus-reporting sequences when tabs switch and we move focus
      // between mounted terminals. Those should not be forwarded into the PTY.
      if (
        (data === "\x1b[I" || data === "\x1b[O") &&
        Date.now() < suppressedFocusSequenceUntilRef.current
      ) {
        return;
      }

      // Ctrl+C interrupts the foreground agent turn but keeps the interactive
      // PTY alive. Some providers do not emit their Stop hook in this path, so
      // converge the UI to input-waiting immediately instead of leaving the
      // activity indicator breathing until another provider event arrives.
      if (containsTerminalInterrupt(data)) {
        const session = useAppStore.getState().sessions.find((item) => item.id === sessionId);
        if (
          session &&
          isAiAgentId(session.agentId) &&
          (session.status === "starting" || session.status === "running")
        ) {
          updateSession(sessionId, {
            status: "waiting",
            statusUpdatedAt: Date.now(),
          });
        }
      }

      const submissionCapture = consumeTerminalSubmissionInput(
        pendingSubmissionInputRef.current,
        data,
        pendingSubmissionEscapeSequenceRef.current,
      );
      pendingSubmissionInputRef.current = submissionCapture.nextValue;
      pendingSubmissionEscapeSequenceRef.current = submissionCapture.pendingSequence;

      if (data === "\r" || data === "\n") {
        setPastedImagePreview(null);
        setPastedImageDialogOpen(false);
        captureInputForAutoTitleRef.current?.(data);
        if (!hasTerminalPromptText(submissionCapture.submittedText)) {
          if (queuedInputOperations > 0) {
            enqueueInput(() => ptyInput(sessionId, data));
          } else {
            ptyInput(sessionId, data).catch(console.error);
          }
          return;
        }

        enqueueInput(async () => {
          try {
            const submittingSession = useAppStore.getState().sessions.find(
              (item) => item.id === sessionId,
            );
            if (submittingSession?.agentId && isAiAgentId(submittingSession.agentId)) {
              beginContentOverviewTurn(sessionId);
            }
            const result = await submitAgentTurnInput(sessionId, data);
            updateSession(sessionId, {
              hasPromptHistory: true,
              checkpointActiveTurnId: result.turn?.id ?? null,
              checkpointWarning: result.warning,
            });
            if (result.warning) {
              console.warn(`[checkpoint:${sessionId}] ${result.warning}`);
            }
          } catch (error) {
            // The backend only rejects when the PTY input itself could not be delivered.
            console.error(error);
            updateSession(sessionId, { status: "error" });
          }
        });
        return;
      }
      captureInputForAutoTitleRef.current?.(data);
      if (queuedInputOperations > 0) {
        enqueueInput(() => ptyInput(sessionId, data));
      } else {
        ptyInput(sessionId, data).catch(console.error);
      }
    });

    // Smart Ctrl+C / Ctrl+V / Ctrl+L handling
    term.attachCustomKeyEventHandler((event) => {
      const isPlainCtrlCombo = event.ctrlKey && !event.shiftKey && !event.altKey;
      const lowerKey = event.key.toLowerCase();

      // Ctrl+C: copy selection if text is selected, otherwise send SIGINT
      if (isPlainCtrlCombo && lowerKey === "c") {
        if (event.type !== "keydown") {
          return false;
        }
        event.preventDefault();
        event.stopPropagation();
        if (term.hasSelection()) {
          navigator.clipboard.writeText(term.getSelection()).catch(() => {});
          return false; // don't send to PTY
        }
        return true; // send SIGINT to PTY
      }

      // Ctrl+V: paste from clipboard
      if (isPlainCtrlCombo && lowerKey === "v") {
        if (event.type !== "keydown") {
          return false;
        }
        event.preventDefault();
        event.stopPropagation();
        const now = Date.now();
        if (now - lastPasteTriggerAtRef.current < 150) {
          return false;
        }
        lastPasteTriggerAtRef.current = now;
        pasteIntoTerminal(term).catch(() => {
          message.error(t("terminal.clipboardReadFailed"));
        });
        return false; // don't send raw \x16 to PTY
      }

      // Ctrl+L: clear current input line (rebinds the browser-default address-bar shortcut)
      if (isPlainCtrlCombo && lowerKey === "l") {
        if (event.type !== "keydown") {
          return false;
        }
        event.preventDefault();
        event.stopPropagation();
        ptyInput(sessionId, "\x15").catch(console.error);
        return false; // don't send raw \x0c to PTY
      }

      return true; // let xterm handle all other keys
    });

    // Resize PTY only when the character grid changes. Claude and other
    // full-screen TUIs redraw on SIGWINCH, so duplicate resize calls pollute
    // the normal-screen scrollback with historical full-screen frames.
    const requestPtyResize = createPtyResizeGate((rows, cols) => {
      ptyResize(sessionId, rows, cols).catch(console.error);
    });

    const syncSize = () => {
      if (!containerRef.current || containerRef.current.clientWidth === 0) return;
      fitAddon.fit();
      requestPtyResize(term.rows, term.cols);
    };

    // Full refresh: resize + force canvas redraw (for display:none → block transitions)
    const fullRefresh = () => {
      if (!containerRef.current || containerRef.current.clientWidth === 0) return;
      fitAddon.fit();
      requestPtyResize(term.rows, term.cols);
      // Force xterm.js to redraw the canvas after container becomes visible
      term.refresh(0, term.rows - 1);
    };

    let layoutSyncAnimationFrame: number | null = null;
    const scheduleSync = () => {
      if (layoutSyncAnimationFrame !== null) return;
      layoutSyncAnimationFrame = requestAnimationFrame(() => {
        layoutSyncAnimationFrame = null;
        fullRefresh();
      });
    };

    // Initial fit after DOM is ready
    const fitTimeout = setTimeout(syncSize, 100);

    const observer = new ResizeObserver(() => scheduleSync());
    observer.observe(containerRef.current);

    // Re-fit when container becomes visible (e.g. tab switch from display:none to display:block)
    const intersectionObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          scheduleSync();
        }
      },
      { threshold: 0 }
    );
    intersectionObserver.observe(containerRef.current);

    const handleLayoutSync = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
      if (detail?.sessionId !== sessionId) return;
      scheduleSync();
    };
    window.addEventListener(TERMINAL_LAYOUT_SYNC_EVENT, handleLayoutSync as EventListener);

    // --- IME composition 缓冲：组合期间暂停 PTY 输出写入，避免光标漂移 ---
    let isComposing = false;
    let pendingOutput = "";

    const textarea = containerRef.current.querySelector("textarea");
    const onCompositionStart = () => {
      isComposing = true;
      pendingOutput = "";
    };
    const onCompositionEnd = () => {
      isComposing = false;
      if (pendingOutput) {
        term.write(keepRunningCursorHidden(pendingOutput, hideCursorWhileRunningRef.current));
        pendingOutput = "";
      }
    };
    if (textarea) {
      textarea.addEventListener("compositionstart", onCompositionStart);
      textarea.addEventListener("compositionend", onCompositionEnd);
    }

    // Listen for PTY output from Rust
    const outputPromise = listen<{ session_id: string; data: string }>(
      "pty-output",
      (event) => {
        if (event.payload.session_id === sessionId) {
          overviewOutputSource.append(event.payload.data);
          if (isComposing) {
            pendingOutput += event.payload.data;
          } else {
            term.write(
              keepRunningCursorHidden(event.payload.data, hideCursorWhileRunningRef.current),
            );
          }
        }
      }
    );
    const voiceInputPromise = listen<{ sessionId: string; text: string }>(
      "voice-terminal-input",
      (event) => {
        if (event.payload.sessionId !== sessionId || !event.payload.text) {
          return;
        }

        const inputCapture = consumeTerminalSubmissionInput(
          pendingSubmissionInputRef.current,
          event.payload.text,
          pendingSubmissionEscapeSequenceRef.current,
        );
        pendingSubmissionInputRef.current = inputCapture.nextValue;
        pendingSubmissionEscapeSequenceRef.current = inputCapture.pendingSequence;
        captureInputForAutoTitleRef.current?.(event.payload.text);

        enqueueInput(() => ptyInput(sessionId, event.payload.text));
      },
    );
    // Listen for PTY exit
    const exitPromise = listen<{ session_id: string; code: number | null }>(
      "pty-exit",
      (event) => {
        if (event.payload.session_id === sessionId) {
          term.write(`\r\n\x1b[33m[${t("terminal.processExited")}]\x1b[0m\r\n`);
          onExitRef.current?.();
          if (onCloseRef.current) {
            setTimeout(onCloseRef.current, 1500);
          }
        }
      }
    );

    const currentWindow = getCurrentWindow();
    const dropPromise = currentWindow.onDragDropEvent((event) => {
      if (event.payload.type === "leave") {
        setIsImageDragOver(false);
        return;
      }

      if (event.payload.type === "enter" || event.payload.type === "over") {
        setIsImageDragOver(isDropPositionInsideTerminalRef.current?.(event.payload.position) ?? false);
        return;
      }

      if (event.payload.type === "drop") {
        const insideTerminal = isDropPositionInsideTerminalRef.current?.(event.payload.position) ?? false;
        setIsImageDragOver(false);
        if (!insideTerminal) {
          return;
        }

        insertDroppedImagePaths(sessionId, event.payload.paths, t).catch((error) => {
          const errorMessage =
            error instanceof Error ? error.message : t("terminal.dropImageFailed");
          message.error(errorMessage);
        });
      }
    });

    return () => {
      isTerminalDisposed = true;
      if (fallbackAnimationFrame !== null) {
        window.cancelAnimationFrame(fallbackAnimationFrame);
        fallbackAnimationFrame = null;
      }
      if (layoutSyncAnimationFrame !== null) {
        window.cancelAnimationFrame(layoutSyncAnimationFrame);
        layoutSyncAnimationFrame = null;
      }
      clearTimeout(fitTimeout);
      observer.disconnect();
      intersectionObserver.disconnect();
      window.removeEventListener(TERMINAL_LAYOUT_SYNC_EVENT, handleLayoutSync as EventListener);
      // 清理 composition 事件监听器
      if (textarea) {
        textarea.removeEventListener("compositionstart", onCompositionStart);
        textarea.removeEventListener("compositionend", onCompositionEnd);
      }
      filePathDisposable.dispose();
      unregisterOverviewNavigator();
      overviewOutputSource.dispose();
      voiceInputPromise.then((unlisten) => unlisten());
      cursorStyleDisposable?.dispose();
      disposeWebglAddon();
      outputPromise.then((unlisten) => unlisten());
      exitPromise.then((unlisten) => unlisten());
      dropPromise.then((unlisten) => unlisten());
      terminalRef.current = null;
      term.dispose();
    };
  }, [
    sessionId,
    overviewNavigationId,
    termTheme,
    fontSize,
    cursorBlink,
    lineHeight,
    terminalScrollback,
    terminalRenderer,
    forceStableCursor,
    openTerminalLink,
    t,
    openFileTab,
    setActiveSidebarSection,
    setSidebarCollapsed,
    showExternalImagePreview,
    showLocalImagePreview,
    scheduleImagePreviewDismissal,
    pasteIntoTerminal,
  ]);

  useEffect(() => {
    if (!terminalRef.current) return;
    terminalRef.current.options.disableStdin =
      !currentSession?.active || currentSession?.status === "starting";
  }, [currentSession?.active, currentSession?.status]);

  useEffect(() => {
    const term = terminalRef.current;
    if (!term || !manageAgentCursorVisibility) return;
    term.write(hideCursorWhileRunning ? HIDE_CURSOR_SEQUENCE : SHOW_CURSOR_SEQUENCE);
  }, [hideCursorWhileRunning, manageAgentCursorVisibility]);

  useEffect(() => {
    const container = containerRef.current;
    const term = terminalRef.current;
    if (!container || !term) return;

    const shouldFocus = currentSession?.active && currentSession?.status !== "starting";
    const focusTerminal = () => {
      const textarea = container.querySelector("textarea");
      const isTerminalFocused = textarea instanceof HTMLTextAreaElement && document.activeElement === textarea;
      if (isTerminalFocused) return;
      suppressedFocusSequenceUntilRef.current = Date.now() + 300;
      term.focus();
    };

    if (shouldFocus) {
      const animationFrames: number[] = [];
      const timers = TERMINAL_FOCUS_RETRY_DELAYS_MS.map((delay) =>
        window.setTimeout(() => {
          focusTerminal();
          animationFrames.push(window.requestAnimationFrame(focusTerminal));
        }, delay)
      );
      return () => {
        timers.forEach((timer) => window.clearTimeout(timer));
        animationFrames.forEach((frame) => window.cancelAnimationFrame(frame));
      };
    }

    const textarea = container.querySelector("textarea");
    if (textarea instanceof HTMLTextAreaElement && document.activeElement === textarea) {
      suppressedFocusSequenceUntilRef.current = Date.now() + 300;
      textarea.blur();
    }
  }, [currentSession?.active, currentSession?.status, sessionId]);

  return (
    <>
      <Dropdown
        menu={{
          items: contextMenuItems,
          onClick: ({ key }) => handleContextMenuClick(key),
        }}
        trigger={["contextMenu"]}
        onOpenChange={handleContextMenuOpenChange}
      >
        <div
          ref={containerRef}
          className="app-terminal-surface w-full h-full p-1"
          style={{
            background: termTheme.cssBackground,
            outline: isImageDragOver || isAgentFileDragOver ? "2px dashed var(--cs-accent)" : "none",
            outlineOffset: isImageDragOver || isAgentFileDragOver ? "-4px" : "0",
            position: "relative",
          }}
          onDragEnter={handleAgentFileDragEnter}
          onDragOver={handleAgentFileDragOver}
          onDragLeave={handleAgentFileDragLeave}
          onDrop={handleAgentFileDrop}
        >
          {isAgentFileDragOver ? (
            <div
              className="pointer-events-none absolute inset-x-3 bottom-3 z-10 rounded border px-3 py-2 text-xs shadow-sm"
              style={{
                borderColor: "var(--cs-accent)",
                background: "var(--cs-bg-card-solid, rgba(255,255,255,0.94))",
                color: "var(--cs-text-primary)",
              }}
            >
              <div className="font-medium">
                {t("terminal.dropFilesIntoAgent", {
                  agent: currentSession?.agentId ? formatTerminalAgentName(currentSession.agentId) : t("terminal.agentFallback"),
                })}
              </div>
              <div style={{ color: "var(--cs-text-secondary)" }}>
                {t("terminal.dropFilesIntoAgentHint")}
              </div>
            </div>
          ) : null}
          {imagePreview ? (
            <div
              className="xterm-hover absolute z-20 overflow-hidden rounded border p-1 shadow-lg"
              style={{
                left: imagePreview.x,
                top: imagePreview.y,
                maxWidth: 320,
                maxHeight: 240,
                borderColor: "var(--cs-border)",
                background: "var(--cs-bg-card-solid, rgba(255,255,255,0.98))",
              }}
              onMouseEnter={cancelImagePreviewDismissal}
              onMouseLeave={scheduleImagePreviewDismissal}
            >
              <img
                src={imagePreview.src}
                alt={imagePreview.alt}
                className="block max-h-[230px] max-w-[310px] object-contain"
                onError={hideImagePreview}
              />
            </div>
          ) : null}
          {pastedImagePreview ? (
            <div
              className="absolute bottom-4 right-4 z-20 h-[92px] w-[116px] overflow-visible rounded-[10px] border p-1.5 shadow-xl"
              style={{
                borderColor: "var(--cs-border)",
                background: "var(--cs-bg-card-solid, rgba(255,255,255,0.98))",
              }}
            >
              <button
                type="button"
                className="block h-full w-full overflow-hidden rounded-[6px] border-0 p-0"
                style={{ background: "color-mix(in srgb, var(--cs-bg-sidebar) 88%, transparent)" }}
                title={t("terminal.openPastedImagePreview")}
                onClick={() => setPastedImageDialogOpen(true)}
              >
                <img
                  src={pastedImagePreview.src}
                  alt={pastedImagePreview.alt}
                  className="block h-full w-full object-contain"
                />
              </button>
              <button
                type="button"
                className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full border shadow-md"
                style={{
                  borderColor: "var(--cs-border)",
                  background: "var(--cs-bg-card-solid, #fff)",
                  color: "var(--cs-text-secondary)",
                }}
                title={t("terminal.closePastedImagePreview")}
                aria-label={t("terminal.closePastedImagePreview")}
                onClick={() => {
                  setPastedImageDialogOpen(false);
                  setPastedImagePreview(null);
                }}
              >
                <CloseOutlined style={{ fontSize: 11 }} />
              </button>
            </div>
          ) : null}
        </div>
      </Dropdown>
      <SideQuestionComposer
        open={Boolean(sideQuestionDraft)}
        agent={sideQuestionDraft?.agent ?? null}
        context={sideQuestionDraft
          ? { kind: "terminal", selection: sideQuestionDraft.context }
          : null}
        question={sideQuestionText}
        onQuestionChange={setSideQuestionText}
        onCancel={closeSideQuestionComposer}
        onSubmit={handleSideQuestionSubmit}
      />
      <Modal
        open={pastedImageDialogOpen && Boolean(pastedImagePreview)}
        title={t("terminal.pastedImagePreviewTitle")}
        footer={null}
        width="min(880px, calc(100vw - 48px))"
        centered
        onCancel={() => setPastedImageDialogOpen(false)}
        destroyOnHidden={false}
      >
        {pastedImagePreview ? (
          <div className="flex max-h-[72vh] items-center justify-center overflow-auto rounded border p-2" style={{ borderColor: "var(--cs-border)" }}>
            <img
              src={pastedImagePreview.src}
              alt={pastedImagePreview.alt}
              className="block max-h-[68vh] max-w-full object-contain"
            />
          </div>
        ) : null}
      </Modal>
      <Modal
        open={Boolean(pendingTerminalLink)}
        title={t("terminal.openLinkConfirmTitle")}
        okText={t("terminal.openLinkConfirmOk")}
        cancelText={t("common.cancel")}
        confirmLoading={openingTerminalLink}
        onOk={() => void handleConfirmTerminalLinkOpen()}
        onCancel={() => !openingTerminalLink && setPendingTerminalLink(null)}
      >
        <p>{t("terminal.openLinkConfirmContent")}</p>
        <p className="break-all text-sm" style={{ color: "var(--cs-text-secondary)" }}>
          {pendingTerminalLink?.kind === "project"
            ? pendingTerminalLink.path.filePath
            : pendingTerminalLink?.href}
        </p>
      </Modal>
    </>
  );
}

export default Terminal;

async function pasteClipboardIntoTerminal(
  sessionId: string,
  term: XTerm | null,
  t: (key: string, options?: Record<string, unknown>) => string
): Promise<TerminalPastedImagePreview | null> {
  const text = await navigator.clipboard.readText().catch(() => "");
  if (text) {
    // Let xterm normalize line endings and emit bracketed paste when the app enabled it.
    if (term) {
      term.paste(text);
      return null;
    }

    await ptyInput(sessionId, text);
    return null;
  }

  const clipboardImage = await readClipboardImage();
  if (clipboardImage) {
    const dataBase64 = await blobToBase64(clipboardImage.blob);
    const saved = await saveClipboardImage(dataBase64, clipboardImage.mimeType);
    const insertedText = quotePathForShell(saved.path);
    await ptyInput(sessionId, insertedText);
    return {
      src: `data:${clipboardImage.mimeType};base64,${dataBase64}`,
      alt: saved.fileName,
      insertedText,
    };
  }

  message.warning(t("terminal.clipboardEmpty"));
  return null;
}

async function readClipboardImage(): Promise<{ blob: Blob; mimeType: string } | null> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.read) {
    return null;
  }

  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imageType = item.types.find((type) => type.startsWith("image/"));
      if (imageType) {
        const blob = await item.getType(imageType);
        return { blob, mimeType: imageType };
      }
    }
  } catch {
    return null;
  }

  return null;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read image data"));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Failed to read image data"));
        return;
      }

      const commaIndex = result.indexOf(",");
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

function quotePathForShell(path: string): string {
  const escaped = path.replace(/"/g, '\\"');
  return `"${escaped}"`;
}

async function insertDroppedImagePaths(
  sessionId: string,
  paths: string[],
  t: (key: string, options?: Record<string, unknown>) => string
) {
  const imagePaths = paths.filter(isSupportedImagePath);
  if (imagePaths.length === 0) {
    message.warning(t("terminal.dragImageUnsupported"));
    return;
  }

  const payload = imagePaths.map((path) => quotePathForShell(path)).join(" ");
  await ptyInput(sessionId, payload);
  message.success(t("terminal.dragImageInserted", { count: imagePaths.length }));
}

function isSupportedImagePath(path: string): boolean {
  return /\.(png|jpe?g|webp|gif)$/i.test(path);
}

function hasAgentFileDragPayload(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(AGENT_FILE_DRAG_MIME);
}

function readAgentFileDragPayload(dataTransfer: DataTransfer): AgentFileDropPayload | null {
  const raw = dataTransfer.getData(AGENT_FILE_DRAG_MIME);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<AgentFileDropPayload>;
    if (parsed.type !== "termflow-agent-files" || typeof parsed.projectPath !== "string" || !Array.isArray(parsed.entries)) {
      return null;
    }

    const entries = parsed.entries
      .filter((entry): entry is AgentFileDropEntry =>
        !!entry &&
        typeof entry.path === "string" &&
        (entry.kind === "file" || entry.kind === "directory")
      )
      .map((entry) => ({
        path: sanitizePromptPath(entry.path),
        kind: entry.kind,
        name: typeof entry.name === "string" ? entry.name : undefined,
      }))
      .filter((entry) => entry.path.length > 0);

    return {
      type: "termflow-agent-files",
      projectPath: sanitizePromptPath(parsed.projectPath),
      entries,
    };
  } catch {
    return null;
  }
}

function buildAgentFileReferencePrompt({
  agentId,
  projectPath,
  entries,
}: {
  agentId: string | undefined;
  projectPath: string;
  entries: AgentFileDropEntry[];
}): string {
  const references = entries.map((entry) => formatAgentFileReference(agentId, projectPath, entry));
  if (references.length === 0) return "";

  if (agentId === "powershell" || agentId === "cmd") {
    return references.join(" ");
  }

  return references.join(" ");
}

function formatAgentFileReference(
  agentId: string | undefined,
  projectPath: string,
  entry: AgentFileDropEntry
): string {
  const path = buildAgentReferencePath(projectPath, entry.path);

  switch (agentId) {
    case "claude":
    case "antigravity":
    case "opencode":
      return `@${path}`;
    case "codex":
    case "qoder":
      return entry.kind === "directory"
        ? `${path} (${entry.kind})`
        : path;
    case "powershell":
    case "cmd":
      return quotePathForShell(entry.path);
    default:
      return path;
  }
}

function buildAgentReferencePath(projectPath: string, entryPath: string): string {
  const normalizedProject = normalizePromptPath(projectPath);
  const normalizedEntry = normalizePromptPath(entryPath);
  const prefix = `${normalizedProject}/`;
  const path = normalizedEntry.startsWith(prefix)
    ? normalizedEntry.slice(prefix.length)
    : normalizedEntry;

  return path || ".";
}

function normalizePromptPath(path: string): string {
  return sanitizePromptPath(path).replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

function sanitizePromptPath(path: string): string {
  return path.replace(/[\r\n]/g, " ").trim();
}

function formatTerminalAgentName(agentId: string): string {
  if (isAiAgentId(agentId)) {
    return getAgentDisplayName(agentId);
  }
  switch (agentId) {
    case "powershell":
      return "PowerShell";
    case "cmd":
      return "CMD";
    default:
      return agentId;
  }
}

function confirmAntigravityDirectoryDrop(
  t: (key: string, options?: Record<string, unknown>) => string
): Promise<boolean> {
  return new Promise((resolve) => {
    Modal.confirm({
      title: t("terminal.antigravityDirectoryDropTitle"),
      content: t("terminal.antigravityDirectoryDropContent"),
      okText: t("common.confirm"),
      cancelText: t("common.cancel"),
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}
