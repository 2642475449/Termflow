import {
  CloseOutlined,
  FileSearchOutlined,
  LoadingOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { Empty, Input, Modal, Select, Spin, Tooltip, type InputRef } from "antd";
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
import { cancelContentSearch, searchProjectText } from "@/lib/api";
import { requestFileNavigation } from "@/lib/fileNavigation";
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

const DEFAULT_EXCLUDE_PATTERNS = [
  "node_modules/**",
  "target/**",
  "dist/**",
  "build/**",
  ".git/**",
];

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
  const [excludePatterns, setExcludePatterns] = useState(DEFAULT_EXCLUDE_PATTERNS.join(", "));
  const [matches, setMatches] = useState<ContentSearchMatch[]>([]);
  const [selectedMatch, setSelectedMatch] = useState<ContentSearchMatch | null>(null);
  const [summary, setSummary] = useState<ContentSearchSummary | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<InputRef | null>(null);
  const activeSearchIdRef = useRef<string | null>(null);
  const searchInFlightRef = useRef(false);
  const pendingMatchesRef = useRef<ContentSearchMatch[]>([]);
  const resultFlushTimerRef = useRef<number | null>(null);

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
    if (!open) return;
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
        excludePatterns: parsePatterns(excludePatterns),
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
    excludePatterns,
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

  const handleSearchKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "ArrowDown") {
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

  const previewLines = useMemo(() => {
    if (!selectedMatch) return [];
    const firstLine = selectedMatch.lineNumber - selectedMatch.contextBefore.length;
    return [
      ...selectedMatch.contextBefore.map((text, index) => ({
        lineNumber: firstLine + index,
        text,
        matched: false,
      })),
      {
        lineNumber: selectedMatch.lineNumber,
        text: selectedMatch.lineText,
        matched: true,
      },
      ...selectedMatch.contextAfter.map((text, index) => ({
        lineNumber: selectedMatch.lineNumber + index + 1,
        text,
        matched: false,
      })),
    ];
  }, [selectedMatch]);

  const statusText = searching
    ? t("globalSearch.searching")
    : error
      ? error
      : summary
        ? t("globalSearch.summary", {
            matches: summary.matchCount,
            files: summary.matchedFiles,
            scanned: summary.scannedFiles,
            seconds: (summary.durationMs / 1000).toFixed(2),
          })
        : t("globalSearch.ready");

  return (
    <Modal
      className="app-global-search-modal"
      open={open}
      width="min(1100px, 82vw)"
      footer={null}
      onCancel={onClose}
      keyboard
      centered
      title={
        <div className="flex items-center gap-2">
          <FileSearchOutlined />
          <span>{t("globalSearch.title")}</span>
          <span className="app-global-search-shortcut">Ctrl+Shift+F</span>
        </div>
      }
      closeIcon={<CloseOutlined />}
    >
      <div className="app-global-search-shell">
        <div className="app-global-search-controls">
          <Input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            prefix={<SearchOutlined />}
            suffix={searching ? <Spin indicator={<LoadingOutlined spin />} size="small" /> : null}
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
              value={includePatterns}
              onChange={(event) => setIncludePatterns(event.target.value)}
              placeholder={t("globalSearch.includePlaceholder")}
            />
            <Input
              value={excludePatterns}
              onChange={(event) => setExcludePatterns(event.target.value)}
              placeholder={t("globalSearch.excludePlaceholder")}
            />
            <div className="app-global-search-toggles">
              <Tooltip title={t("globalSearch.caseSensitive")}>
                <button
                  type="button"
                  aria-pressed={caseSensitive}
                  onClick={() => setCaseSensitive((value) => !value)}
                >
                  Aa
                </button>
              </Tooltip>
              <Tooltip title={t("globalSearch.wholeWord")}>
                <button
                  type="button"
                  aria-pressed={wholeWord}
                  onClick={() => setWholeWord((value) => !value)}
                >
                  W
                </button>
              </Tooltip>
              <Tooltip title={t("globalSearch.regex")}>
                <button
                  type="button"
                  aria-pressed={useRegex}
                  onClick={() => setUseRegex((value) => !value)}
                >
                  .*
                </button>
              </Tooltip>
            </div>
          </div>
        </div>

        <div className="app-global-search-content">
          <div className="app-global-search-results">
            {!query.trim() ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("globalSearch.enterQuery")} />
            ) : !searching && !error && matches.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("globalSearch.noResults")} />
            ) : (
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
            )}
          </div>

          <div className="app-global-search-preview">
            {selectedMatch ? (
              <>
                <div className="app-global-search-preview-title">
                  <span title={selectedMatch.relativePath}>{selectedMatch.relativePath}</span>
                  <span>{t("globalSearch.line", { line: selectedMatch.lineNumber })}</span>
                </div>
                <div className="app-global-search-preview-code">
                  {previewLines.map((line) => (
                    <div
                      key={line.lineNumber}
                      className="app-global-search-preview-line"
                      data-matched={line.matched ? "true" : "false"}
                    >
                      <span>{line.lineNumber}</span>
                      <code>
                        {line.matched && selectedMatch
                          ? <HighlightedLine match={selectedMatch} />
                          : line.text || " "}
                      </code>
                    </div>
                  ))}
                </div>
                <div className="app-global-search-preview-hint">
                  {t("globalSearch.openHint")}
                </div>
              </>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("globalSearch.selectResult")} />
            )}
          </div>
        </div>

        <div className="app-global-search-status" data-error={error ? "true" : "false"}>
          <span>{statusText}</span>
          {summary?.truncated ? <span>{t("globalSearch.truncated")}</span> : null}
        </div>
      </div>
    </Modal>
  );
}

export default GlobalTextSearchDialog;
