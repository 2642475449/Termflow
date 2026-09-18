import MonacoTextEditor from "@/components/editors/MonacoTextEditor";
import {
  FileSearchOutlined,
  LoadingOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { Button, Input, Modal, Select, Spin, Tooltip, type InputRef } from "antd";
import {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { cancelContentSearch, readProjectFile, searchProjectText } from "@/lib/api";
import { requestFileNavigation } from "@/lib/fileNavigation";
import {
  adjustSearchWindow,
  type SearchWindowBounds,
  DEFAULT_GLOBAL_SEARCH_SPLIT_RATIO,
  MAX_GLOBAL_SEARCH_SPLIT_RATIO,
  MIN_GLOBAL_SEARCH_SPLIT_RATIO,
  globalSearchSplitRatioFromPointer,
} from "@/lib/globalSearchLayout";
import { useAppStore } from "@/store";
import type {
  ContentSearchBatch,
  ContentSearchMatch,
  ContentSearchSummary,
} from "@/types";

interface GlobalTextSearchDialogProps {
  open: boolean;
  initialScopePath?: string | null;
  onClose: () => void;
}

interface SearchResultGroup {
  path: string;
  relativePath: string;
  matches: ContentSearchMatch[];
}

const RESULT_FLUSH_INTERVAL_MS = 100;

function parsePatterns(value: string): string[] {
  return value
    .split(/[,;\n]/)
    .map((pattern) => pattern.trim())
    .filter(Boolean);
}

function matchKey(match: ContentSearchMatch): string {
  return `${match.path}:${match.lineNumber}:${match.startColumn}:${match.endColumn}`;
}

function buildGroups(matches: ContentSearchMatch[]): SearchResultGroup[] {
  const groups = new Map<string, SearchResultGroup>();
  for (const match of matches) {
    const group = groups.get(match.path);
    if (group) {
      group.matches.push(match);
    } else {
      groups.set(match.path, {
        path: match.path,
        relativePath: match.relativePath,
        matches: [match],
      });
    }
  }
  return Array.from(groups.values());
}

function HighlightedLine({ match }: { match: ContentSearchMatch }) {
  const start = Math.max(0, match.startColumn - 1);
  const end = Math.max(start, match.endColumn - 1);
  return (
    <span className="app-global-search-line-text">
      {match.lineText.slice(0, start)}
      <mark>{match.lineText.slice(start, end)}</mark>
      {match.lineText.slice(end)}
    </span>
  );
}

function GlobalTextSearchDialog({
  open,
  initialScopePath = null,
  onClose,
}: GlobalTextSearchDialogProps) {
  const { t } = useTranslation();
  const currentProject = useAppStore((state) => state.currentProject);
  const openFileTab = useAppStore((state) => state.openFileTab);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [scopeMode, setScopeMode] = useState<"project" | "directory">("project");
  const [includePatterns, setIncludePatterns] = useState("");
  const [matches, setMatches] = useState<ContentSearchMatch[]>([]);
  const [selectedMatch, setSelectedMatch] = useState<ContentSearchMatch | null>(null);
  const [summary, setSummary] = useState<ContentSearchSummary | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [splitRatio, setSplitRatio] = useState(DEFAULT_GLOBAL_SEARCH_SPLIT_RATIO);
  const [splitDragging, setSplitDragging] = useState(false);
  const inputRef = useRef<InputRef | null>(null);
  const searchContentRef = useRef<HTMLDivElement | null>(null);
  const splitDraggingRef = useRef(false);
  const activeSearchIdRef = useRef<string | null>(null);
  const searchInFlightRef = useRef(false);
  const pendingMatchesRef = useRef<ContentSearchMatch[]>([]);
  const resultFlushTimerRef = useRef<number | null>(null);

  const [windowBounds, setWindowBounds] = useState<SearchWindowBounds | null>(null);
  const windowGesture = useRef<{ x: number; y: number; direction: string; bounds: SearchWindowBounds } | null>(null);
  const windowSurface = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const fit = () => setWindowBounds((bounds) => bounds
      ? adjustSearchWindow(bounds, "move", 0, 0, window.innerWidth, window.innerHeight) : null);
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  const startWindowGesture = (event: React.PointerEvent<HTMLDivElement>, direction: string) => {
    if (event.button !== 0 || !windowSurface.current) return;
    event.preventDefault();
    const rect = windowSurface.current.getBoundingClientRect();
    const bounds = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    setWindowBounds(bounds);
    windowGesture.current = { x: event.clientX, y: event.clientY, direction, bounds };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveWindowGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = windowGesture.current;
    if (!gesture) return;
    setWindowBounds(adjustSearchWindow(gesture.bounds, gesture.direction,
      event.clientX - gesture.x, event.clientY - gesture.y, window.innerWidth, window.innerHeight));
  };
  const stopWindowGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    windowGesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const deferredMatches = useDeferredValue(matches);

  const groups = useMemo(() => buildGroups(deferredMatches), [deferredMatches]);
  const selectedIndex = useMemo(() => {
    if (!selectedMatch) return -1;
    const key = matchKey(selectedMatch);
    return matches.findIndex((match) => matchKey(match) === key);
  }, [matches, selectedMatch]);
  const matchIndexByKey = useMemo(
    () => new Map(deferredMatches.map((match, index) => [matchKey(match), index])),
    [deferredMatches]
  );
  const directoryScopeLabel = useMemo(() => {
    if (!currentProject || !initialScopePath) return null;
    const normalizedRoot = currentProject.path.replace(/\\/g, "/").replace(/\/+$/, "");
    const normalizedScope = initialScopePath.replace(/\\/g, "/").replace(/\/+$/, "");
    const relativePath = normalizedScope.startsWith(`${normalizedRoot}/`)
      ? normalizedScope.slice(normalizedRoot.length + 1)
      : normalizedScope;
    return relativePath || currentProject.name;
  }, [currentProject, initialScopePath]);

  useEffect(() => {
    const flushPendingMatches = () => {
      resultFlushTimerRef.current = null;
      const pending = pendingMatchesRef.current;
      if (pending.length === 0) return;
      pendingMatchesRef.current = [];
      startTransition(() => {
        setMatches((previous) => [...previous, ...pending]);
        setSelectedMatch((selected) => selected ?? pending[0] ?? null);
      });
    };

    const unlistenPromise = listen<ContentSearchBatch>("content-search-batch", (event) => {
      if (event.payload.searchId !== activeSearchIdRef.current) return;
      pendingMatchesRef.current.push(...event.payload.matches);
      if (resultFlushTimerRef.current === null) {
        resultFlushTimerRef.current = window.setTimeout(
          flushPendingMatches,
          RESULT_FLUSH_INTERVAL_MS
        );
      }
    });
    return () => {
      if (resultFlushTimerRef.current !== null) {
        window.clearTimeout(resultFlushTimerRef.current);
        resultFlushTimerRef.current = null;
      }
      pendingMatchesRef.current = [];
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    if (!open) {
      splitDraggingRef.current = false;
      setSplitDragging(false);
      return;
    }
    setScopeMode(initialScopePath ? "directory" : "project");
    const timer = window.setTimeout(() => inputRef.current?.focus({ cursor: "all" }), 30);
    return () => window.clearTimeout(timer);
  }, [initialScopePath, open]);

  useEffect(() => {
    const trimmedQuery = query.trim();
    const previousSearchId = activeSearchIdRef.current;
    activeSearchIdRef.current = null;
    if (previousSearchId && searchInFlightRef.current) {
      void cancelContentSearch(previousSearchId);
    }
    searchInFlightRef.current = false;
    if (resultFlushTimerRef.current !== null) {
      window.clearTimeout(resultFlushTimerRef.current);
      resultFlushTimerRef.current = null;
    }
    pendingMatchesRef.current = [];

    if (!open || !currentProject || !trimmedQuery) {
      setSearching(false);
      setMatches([]);
      setSelectedMatch(null);
      setSummary(null);
      setError(null);
      return;
    }

    let disposed = false;
    let settled = false;
    setSearching(false);
    setMatches([]);
    setSelectedMatch(null);
    setSummary(null);
    setError(null);
    const timer = window.setTimeout(() => {
      const searchId = crypto.randomUUID();
      activeSearchIdRef.current = searchId;
      searchInFlightRef.current = true;
      setSearching(true);

      void searchProjectText({
        searchId,
        projectPath: currentProject.path,
        scopePath: scopeMode === "directory" ? initialScopePath : null,
        query: trimmedQuery,
        caseSensitive,
        wholeWord,
        useRegex,
        includePatterns: parsePatterns(includePatterns),
        excludePatterns: [],
      })
        .then((nextSummary) => {
          settled = true;
          if (disposed || activeSearchIdRef.current !== searchId) return;
          setSummary(nextSummary);
        })
        .catch((nextError: unknown) => {
          settled = true;
          if (disposed || activeSearchIdRef.current !== searchId) return;
          setError(nextError instanceof Error ? nextError.message : String(nextError));
        })
        .finally(() => {
          if (activeSearchIdRef.current === searchId) {
            searchInFlightRef.current = false;
          }
          if (!disposed && activeSearchIdRef.current === searchId) {
            setSearching(false);
          }
        });
    }, 280);

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      const searchId = activeSearchIdRef.current;
      if (!settled && searchId && searchInFlightRef.current) {
        void cancelContentSearch(searchId);
      }
    };
  }, [
    caseSensitive,
    currentProject,
    includePatterns,
    open,
    query,
    scopeMode,
    initialScopePath,
    useRegex,
    wholeWord,
  ]);

  const handleOpenMatch = useCallback(
    (match: ContentSearchMatch, keepOpen: boolean) => {
      openFileTab(match.path, { preview: false });
      requestFileNavigation({
        path: match.path,
        lineNumber: match.lineNumber,
        startColumn: match.startColumn,
        endColumn: match.endColumn,
        requestId: crypto.randomUUID(),
      });
      if (!keepOpen) onClose();
    },
    [onClose, openFileTab]
  );

  const moveSelection = useCallback(
    (offset: number) => {
      if (matches.length === 0) return;
      const nextIndex = selectedIndex < 0
        ? 0
        : (selectedIndex + offset + matches.length) % matches.length;
      setSelectedMatch(matches[nextIndex]);
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(`[data-search-result-index="${nextIndex}"]`)
          ?.scrollIntoView({ block: "nearest" });
      });
    },
    [matches, selectedIndex]
  );

  const updateSplitFromPointer = useCallback((clientX: number) => {
    const content = searchContentRef.current;
    if (!content) return;
    const bounds = content.getBoundingClientRect();
    setSplitRatio(globalSearchSplitRatioFromPointer(clientX, bounds.left, bounds.width));
  }, []);

  const finishSplitDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    splitDraggingRef.current = false;
    setSplitDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handleSearchKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.altKey && ["c", "w", "r"].includes(event.key.toLowerCase())) {
        event.preventDefault();
        if (event.key.toLowerCase() === "c") setCaseSensitive((value) => !value);
        if (event.key.toLowerCase() === "w") setWholeWord((value) => !value);
        if (event.key.toLowerCase() === "r") setUseRegex((value) => !value);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        moveSelection(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        moveSelection(-1);
      } else if (event.key === "Enter" && selectedMatch) {
        event.preventDefault();
        handleOpenMatch(selectedMatch, event.ctrlKey || event.metaKey);
      }
    },
    [handleOpenMatch, moveSelection, selectedMatch]
  );

  const previewPath = selectedMatch?.path;
  const [preview, setPreview] = useState<{ path: string; content: string; error: string | null } | null>(null);
  useEffect(() => {
    if (!open || !previewPath || !currentProject) {
      setPreview(null);
      return;
    }
    let disposed = false;
    setPreview(null);
    void readProjectFile(currentProject.path, previewPath).then((file) => {
      if (disposed) return;
      setPreview({ path: previewPath, content: file.content,
        error: file.kind === "text" ? null : t("globalSearch.previewUnavailable") });
    }).catch((reason: unknown) => {
      if (disposed) return;
      setPreview({ path: previewPath, content: "", error: String(reason) });
    });
    return () => { disposed = true; };
  }, [open, previewPath, currentProject?.path, t]);
  const previewTarget = useMemo(() => selectedMatch ? {
    lineNumber: selectedMatch.lineNumber,
    startColumn: selectedMatch.startColumn,
    endColumn: selectedMatch.endColumn,
    requestId: matchKey(selectedMatch),
  } : null, [selectedMatch]);

  const statusText = searching
    ? t("globalSearch.searching")
    : error
      ? error
      : summary
        ? t("globalSearch.summary", {
            matches: summary.matchCount,
            files: summary.matchedFiles,
          })
        : "";

  return (
    <Modal
      className="app-global-search-modal"
      open={open}
      width={windowBounds?.width ?? "min(1280px, 92vw)"}
      style={windowBounds ? { position: "fixed", left: windowBounds.left, top: windowBounds.top, margin: 0, paddingBottom: 0 } : undefined}
      styles={{ body: windowBounds ? { height: windowBounds.height, minHeight: 0 } : undefined }}
      footer={null}
      onCancel={onClose}
      keyboard
      centered={!windowBounds}
      closable={false}
    >
      <div ref={windowSurface} className="app-global-search-shell" aria-label={t("globalSearch.title")}>
        <div className="app-global-search-drag" title={t("globalSearch.moveWindow")}
          onPointerDown={(event) => startWindowGesture(event, "move")}
          onPointerMove={moveWindowGesture} onPointerUp={stopWindowGesture}
          onPointerCancel={stopWindowGesture} onLostPointerCapture={() => { windowGesture.current = null; }} />
        {["n", "s", "e", "w", "ne", "nw", "se", "sw"].map((direction) => (
          <div key={direction} className={`app-global-search-resize app-global-search-resize-${direction}`}
            title={t("globalSearch.resizeWindow")}
            onPointerDown={(event) => startWindowGesture(event, direction)}
            onPointerMove={moveWindowGesture} onPointerUp={stopWindowGesture}
            onPointerCancel={stopWindowGesture} onLostPointerCapture={() => { windowGesture.current = null; }} />
        ))}
        <div className="app-global-search-controls">
          <Input
            className="app-global-search-query"
            aria-label={t("globalSearch.title")}
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            prefix={<SearchOutlined />}
            suffix={
              <>
                {searching ? <Spin indicator={<LoadingOutlined spin />} size="small" /> : null}
                <div className="app-global-search-toggles">
                  <Tooltip title={<>{t("globalSearch.caseSensitive")} <kbd>Alt+C</kbd></>}>
                    <button
                      type="button"
                      aria-label={t("globalSearch.caseSensitive")}
                      aria-pressed={caseSensitive}
                      onClick={() => setCaseSensitive((value) => !value)}
                    >
                      Aa
                    </button>
                  </Tooltip>
                  <Tooltip title={<>{t("globalSearch.wholeWord")} <kbd>Alt+W</kbd></>}>
                    <button
                      type="button"
                      aria-label={t("globalSearch.wholeWord")}
                      aria-pressed={wholeWord}
                      onClick={() => setWholeWord((value) => !value)}
                    >
                      W
                    </button>
                  </Tooltip>
                  <Tooltip title={<>{t("globalSearch.regex")} <kbd>Alt+R</kbd></>}>
                    <button
                      type="button"
                      aria-label={t("globalSearch.regex")}
                      aria-pressed={useRegex}
                      onClick={() => setUseRegex((value) => !value)}
                    >
                      .*
                    </button>
                  </Tooltip>
                </div>
              </>
            }
            placeholder={t("globalSearch.placeholder")}
            allowClear
            size="large"
          />
          <div className="app-global-search-options">
            <Select
              className="app-global-search-scope"
              value={scopeMode}
              onChange={setScopeMode}
              options={[
                {
                  value: "project",
                  label: t("globalSearch.entireProject", { name: currentProject?.name ?? "" }),
                },
                ...(initialScopePath && directoryScopeLabel
                  ? [{
                      value: "directory" as const,
                      label: t("globalSearch.directoryScope", { path: directoryScopeLabel }),
                    }]
                  : []),
              ]}
            />
            <Input
              className="app-global-search-filter"
              value={includePatterns}
              allowClear
              aria-label={t("globalSearch.fileFilter")}
              onChange={(event) => setIncludePatterns(event.target.value)}
              placeholder={t("globalSearch.includePlaceholder")}
            />
          </div>
        </div>

        {matches.length === 0 ? (
          <div className="app-global-search-empty">
            {error ? <p role="alert">{error}</p> : searching ? <Spin /> : query.trim() && summary ? (
              <><SearchOutlined /><strong>{t("globalSearch.noResults")}</strong><p>{t("globalSearch.noResultsHint")}</p></>
            ) : <div className="app-global-search-guide">
              <span><kbd>*.ts</kbd> {t("globalSearch.fileFilter")}</span>
              <span><kbd>Alt+C</kbd> {t("globalSearch.caseSensitive")}</span>
              <span><kbd>Alt+R</kbd> {t("globalSearch.regex")}</span>
            </div>}
          </div>
        ) : (
        <div
          ref={searchContentRef}
          className="app-global-search-content"
          data-resizing={splitDragging ? "true" : "false"}
          style={{
            gridTemplateColumns: `minmax(0, ${splitRatio}fr) 8px minmax(0, ${100 - splitRatio}fr)`,
          }}
        >
          <div className="app-global-search-results">
            {
              groups.map((group) => (
                <section key={group.path} className="app-global-search-group">
                  <div className="app-global-search-group-title" title={group.relativePath}>
                    <span>{group.relativePath}</span>
                    <span>{group.matches.length}</span>
                  </div>
                  {group.matches.map((match) => {
                    const resultIndex = matchIndexByKey.get(matchKey(match)) ?? -1;
                    const selected = selectedMatch ? matchKey(selectedMatch) === matchKey(match) : false;
                    return (
                      <button
                        key={`${matchKey(match)}:${resultIndex}`}
                        type="button"
                        data-search-result-index={resultIndex}
                        data-selected={selected ? "true" : "false"}
                        className="app-global-search-result"
                        onClick={() => setSelectedMatch(match)}
                        onDoubleClick={() => handleOpenMatch(match, false)}
                      >
                        <span className="app-global-search-line-number">{match.lineNumber}</span>
                        <HighlightedLine match={match} />
                      </button>
                    );
                  })}
                </section>
              ))
            }
          </div>

          <div
            className="app-global-search-splitter"
            data-dragging={splitDragging ? "true" : "false"}
            role="separator"
            aria-orientation="vertical"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              setSplitRatio((value) => Math.max(MIN_GLOBAL_SEARCH_SPLIT_RATIO, Math.min(MAX_GLOBAL_SEARCH_SPLIT_RATIO, value + (event.key === "ArrowRight" ? 2 : -2))));
            }}
            aria-label={t("globalSearch.splitterLabel")}
            aria-valuemin={MIN_GLOBAL_SEARCH_SPLIT_RATIO}
            aria-valuemax={MAX_GLOBAL_SEARCH_SPLIT_RATIO}
            aria-valuenow={Math.round(splitRatio)}
            title={t("globalSearch.splitterHint")}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              splitDraggingRef.current = true;
              setSplitDragging(true);
              event.currentTarget.setPointerCapture(event.pointerId);
              updateSplitFromPointer(event.clientX);
            }}
            onPointerMove={(event) => {
              if (!splitDraggingRef.current) return;
              event.preventDefault();
              updateSplitFromPointer(event.clientX);
            }}
            onPointerUp={finishSplitDrag}
            onPointerCancel={finishSplitDrag}
            onLostPointerCapture={() => {
              splitDraggingRef.current = false;
              setSplitDragging(false);
            }}
            onDoubleClick={() => setSplitRatio(DEFAULT_GLOBAL_SEARCH_SPLIT_RATIO)}
          />

          <div className="app-global-search-preview">
            {selectedMatch ? (
              <>
                <div className="app-global-search-preview-title">
                  <span title={selectedMatch.relativePath}><FileSearchOutlined /> {selectedMatch.relativePath}</span>
                  <div className="app-global-search-preview-actions">
                    <span>{t("globalSearch.position", { line: selectedMatch.lineNumber, column: selectedMatch.startColumn })}</span>
                    <Button
                      type="primary"
                      size="small"
                      onClick={() => handleOpenMatch(selectedMatch, false)}
                    >
                      {t("globalSearch.open")}
                    </Button>
                  </div>
                </div>
                <div className="flex min-h-0 flex-1 flex-col">
                  {!preview || preview.path !== selectedMatch.path ? (
                    <div className="app-global-search-empty"><Spin /></div>
                  ) : preview.error ? (
                    <div className="app-global-search-empty" role="alert">{preview.error}</div>
                  ) : (
                    <MonacoTextEditor
                      key={selectedMatch.path}
                      filePath={`search-preview:///${selectedMatch.path.replace(/\\/g, "/")}`}
                      value={preview.content}
                      readOnly
                      onChange={() => {}}
                      revealTarget={previewTarget}
                      focusOnReveal={false}
                    />
                  )}
                </div>

              </>
            ) : null}
          </div>
        </div>
        )}
        <div className="app-global-search-footer">
          <span className="app-global-search-status" data-error={error ? "true" : "false"} role="status" title={summary?.truncated ? t("globalSearch.truncated") : statusText}>{statusText}</span>
          <div className="app-global-search-keys">
            <span><kbd>↑</kbd><kbd>↓</kbd> {t("globalSearch.navigate")}</span>
            <span><kbd>↵</kbd> {t("globalSearch.open")}</span>
            <span><kbd>Ctrl+↵</kbd> {t("globalSearch.keepOpen")}</span>
            <span><kbd>Esc</kbd> {t("globalSearch.close")}</span>
          </div>
        </div>
      </div>
    </Modal>
  );
}

export default GlobalTextSearchDialog;
