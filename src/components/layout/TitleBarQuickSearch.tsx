import { FolderOutlined, SearchOutlined } from "@ant-design/icons";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Empty, Input, Modal, Spin } from "antd";
import type { InputRef } from "antd";
import { searchProjectEntries } from "@/lib/api";
import { revealExplorerPath } from "@/lib/explorer";
import { getFileIconByName } from "@/lib/fileIcon";
import { shouldIgnoreShortcut } from "@/hooks/useKeyboardShortcuts";
import { useAppStore } from "@/store";
import { useTranslation } from "react-i18next";
import type { FileTreeEntryKind } from "@/types";

interface QuickSearchItem {
  key: string;
  path: string;
  name: string;
  relativePath: string;
  parentPath: string;
  kind: FileTreeEntryKind;
  section: "recent" | "search";
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

function buildRelativePath(rootPath: string, targetPath: string): string {
  const normalizedRoot = normalizePath(rootPath);
  const normalizedTarget = normalizePath(targetPath);
  const prefix = `${normalizedRoot}/`;
  if (normalizedTarget === normalizedRoot) {
    return ".";
  }
  if (normalizedTarget.startsWith(prefix)) {
    return normalizedTarget.slice(prefix.length);
  }
  return targetPath;
}

function getParentPath(relativePath: string): string {
  const normalized = normalizePath(relativePath);
  const separatorIndex = normalized.lastIndexOf("/");
  return separatorIndex < 0 ? "." : normalized.slice(0, separatorIndex) || ".";
}

function highlightMatch(value: string, query: string) {
  const keyword = query.trim().toLocaleLowerCase();
  if (!keyword) return value;

  const lowerValue = value.toLocaleLowerCase();
  const exactIndex = lowerValue.indexOf(keyword);
  if (exactIndex >= 0) {
    return (
      <>
        {value.slice(0, exactIndex)}
        <mark className="rounded-[2px] bg-transparent font-semibold text-[var(--cs-primary)]">
          {value.slice(exactIndex, exactIndex + keyword.length)}
        </mark>
        {value.slice(exactIndex + keyword.length)}
      </>
    );
  }

  const matchedIndexes = new Set<number>();
  let queryIndex = 0;
  for (let index = 0; index < lowerValue.length && queryIndex < keyword.length; index += 1) {
    if (lowerValue[index] === keyword[queryIndex]) {
      matchedIndexes.add(index);
      queryIndex += 1;
    }
  }
  if (queryIndex !== keyword.length) return value;

  return Array.from(value).map((character, index) =>
    matchedIndexes.has(index) ? (
      <mark
        key={`${index}:${character}`}
        className="bg-transparent font-semibold text-[var(--cs-primary)]"
      >
        {character}
      </mark>
    ) : (
      character
    )
  );
}

function TitleBarQuickSearch() {
  const DOUBLE_SHIFT_WINDOW_MS = 320;
  const { t } = useTranslation();
  const currentProject = useAppStore((s) => s.currentProject);
  const tabsById = useAppStore((s) => s.tabsById);
  const openFileTab = useAppStore((s) => s.openFileTab);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<QuickSearchItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const deferredQuery = useDeferredValue(query);
  const inputRef = useRef<InputRef | null>(null);
  const resultListRef = useRef<HTMLDivElement | null>(null);
  const lastShiftKeyDownAtRef = useRef(0);

  const recentItems = useMemo<QuickSearchItem[]>(() => {
    if (!currentProject) return [];
    return Object.values(tabsById)
      .filter((tab) => tab.kind === "file")
      .sort((left, right) => right.lastActivatedAt - left.lastActivatedAt)
      .slice(0, 8)
      .map((tab) => {
        const relativePath = buildRelativePath(currentProject.path, tab.resourceId);
        return {
          key: `recent:${tab.resourceId}`,
          path: tab.resourceId,
          name: tab.title,
          relativePath,
          parentPath: getParentPath(relativePath),
          kind: "file" as const,
          section: "recent" as const,
        };
      });
  }, [currentProject, tabsById]);

  const visibleItems = useMemo(() => {
    const trimmedQuery = query.trim();
    return trimmedQuery ? results : recentItems;
  }, [query, recentItems, results]);

  const openSearch = useCallback(() => {
    setOpen(true);
  }, []);

  const closeSearch = useCallback(() => {
    setOpen(false);
    setQuery("");
    setResults([]);
    setSearching(false);
    setActiveIndex(0);
  }, []);

  const handleOpenItem = useCallback(
    (item: QuickSearchItem) => {
      if (item.kind === "directory") {
        revealExplorerPath(item.path, "directory");
      } else {
        openFileTab(item.path, { preview: false });
      }
      closeSearch();
    },
    [closeSearch, openFileTab]
  );

  useEffect(() => {
    if (!open) return;
    const handle = window.setTimeout(() => {
      inputRef.current?.focus({ cursor: "all" });
    }, 10);
    return () => window.clearTimeout(handle);
  }, [open]);

  useEffect(() => {
    if (!open || !currentProject) return;

    const trimmedQuery = deferredQuery.trim();
    if (!trimmedQuery) {
      setResults([]);
      setSearching(false);
      return;
    }

    let cancelled = false;
    setSearching(true);

    const timer = window.setTimeout(() => {
      void searchProjectEntries(currentProject.path, trimmedQuery)
        .then((entries) => {
          if (cancelled) return;
          const nextItems = entries
            .slice(0, 50)
            .map((entry) => {
              const relativePath = buildRelativePath(currentProject.path, entry.path);
              return {
                key: `search:${entry.path}`,
                path: entry.path,
                name: entry.name,
                relativePath,
                parentPath: getParentPath(relativePath),
                kind: entry.kind,
                section: "search" as const,
              };
            });
          setResults(nextItems);
          setActiveIndex(0);
        })
        .catch(() => {
          if (!cancelled) {
            setResults([]);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setSearching(false);
          }
        });
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [currentProject, deferredQuery, open]);

  useEffect(() => {
    if (visibleItems.length === 0) {
      setActiveIndex(0);
      return;
    }
    setActiveIndex((prev) => Math.min(prev, visibleItems.length - 1));
  }, [visibleItems]);

  useEffect(() => {
    const activeRow = resultListRef.current?.querySelector<HTMLElement>(
      `[data-quick-search-index="${activeIndex}"]`
    );
    activeRow?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (
        event.key === "Shift" &&
        !event.repeat &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        const target = event.target;
        const isMonacoEditor = target instanceof HTMLElement && !!target.closest(".monaco-editor");
        const isTerminal = target instanceof HTMLElement && !!target.closest(".xterm");
        const isEditableTarget =
          !isMonacoEditor &&
          !isTerminal &&
          target instanceof HTMLElement &&
          (target.isContentEditable ||
            !!target.closest("[contenteditable='true']") ||
            ["input", "textarea", "select"].includes(target.tagName.toLowerCase()));
        if (!isEditableTarget) {
          const now = Date.now();
          if (!open && now - lastShiftKeyDownAtRef.current <= DOUBLE_SHIFT_WINDOW_MS) {
            event.preventDefault();
            event.stopPropagation();
            lastShiftKeyDownAtRef.current = 0;
            openSearch();
            return;
          }
          lastShiftKeyDownAtRef.current = now;
        }
      }

      if (!open || shouldIgnoreShortcut(event)) {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeSearch();
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [closeSearch, open, openSearch]);

  const handleInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (visibleItems.length > 0) {
          setActiveIndex((prev) => (prev + 1) % visibleItems.length);
        }
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        if (visibleItems.length > 0) {
          setActiveIndex((prev) => (prev - 1 + visibleItems.length) % visibleItems.length);
        }
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        const item = visibleItems[activeIndex];
        if (item) {
          handleOpenItem(item);
        }
        return;
      }

      if (event.key === "Tab") {
        event.preventDefault();
        if (visibleItems.length > 0) {
          setActiveIndex(
            (prev) =>
              (prev + (event.shiftKey ? -1 : 1) + visibleItems.length) % visibleItems.length
          );
        }
      }
    },
    [activeIndex, handleOpenItem, visibleItems]
  );

  return (
    <>
      <button
        type="button"
        className="flex h-7 min-w-[148px] items-center gap-2 rounded-[6px] border px-2.5 transition-colors"
        style={{
          background: open
            ? "color-mix(in srgb, var(--cs-bg-card, #ffffff) 92%, var(--cs-bg-hover) 8%)"
            : "color-mix(in srgb, var(--cs-bg-card, #ffffff) 96%, var(--cs-bg-header) 4%)",
          borderColor: open
            ? "color-mix(in srgb, var(--cs-primary) 18%, var(--cs-border-card, var(--cs-border)) 82%)"
            : "color-mix(in srgb, var(--cs-border-card, var(--cs-border)) 92%, transparent)",
          boxShadow: open
            ? "0 0 0 1px color-mix(in srgb, var(--cs-primary) 10%, transparent)"
            : "none",
          color: "var(--cs-text-secondary)",
        }}
        onClick={openSearch}
        title={t("titleBar.quickSearchTooltip")}
      >
        <SearchOutlined className="text-[11px]" />
        <span className="text-[12px]">{t("titleBar.quickSearch")}</span>
      </button>

      <Modal
        open={open}
        footer={null}
        onCancel={closeSearch}
        closeIcon={null}
        width={820}
        style={{ top: "12vh", maxWidth: "calc(100vw - 32px)" }}
        styles={{
          content: {
            padding: 8,
            background: "var(--cs-bg-card)",
            border: "1px solid var(--cs-border-card, var(--cs-border))",
            boxShadow: "0 18px 40px rgba(15, 23, 42, 0.22)",
          },
        }}
      >
        <div
          className="flex flex-col gap-1 rounded-[10px]"
          style={{ background: "var(--cs-bg-card)" }}
        >
          <Input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder={
              currentProject
                ? t("titleBar.quickSearchPlaceholder")
                : t("titleBar.quickSearchNoProjectPlaceholder")
            }
            prefix={<SearchOutlined style={{ color: "var(--cs-text-tertiary)" }} />}
            allowClear
            size="middle"
          />

          <div
            className="overflow-hidden rounded-[8px] border"
            style={{
              borderColor: "var(--cs-border-card, var(--cs-border))",
              background: "var(--cs-bg-card)",
            }}
          >
            {!currentProject ? (
              <div className="px-3 py-8">
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={t("titleBar.quickSearchNoProject")}
                />
              </div>
            ) : visibleItems.length === 0 ? (
              <div className="px-3 py-8">
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={
                    query.trim()
                      ? t("titleBar.quickSearchEmpty")
                      : t("titleBar.quickSearchRecentEmpty")
                  }
                />
              </div>
            ) : (
              <div
                ref={resultListRef}
                className="max-h-[min(520px,65vh)] overflow-y-auto py-1"
                style={{ background: "var(--cs-bg-card)" }}
              >
                {visibleItems.map((item, index) => {
                  const active = index === activeIndex;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      data-quick-search-index={index}
                      className="flex h-[34px] w-full items-center gap-2 px-2.5 text-left transition-colors"
                      style={{
                        background: active ? "var(--cs-bg-hover)" : "var(--cs-bg-card)",
                      }}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => handleOpenItem(item)}
                    >
                      {(() => {
                        if (item.kind === "directory") {
                          return (
                            <div
                              className="flex h-5 w-5 shrink-0 items-center justify-center text-[14px]"
                              style={{ color: "var(--cs-text-secondary)" }}
                            >
                              <FolderOutlined />
                            </div>
                          );
                        }
                        const fileVisual = getFileIconByName(item.name);
                        return (
                          <div
                            className="flex h-5 w-5 shrink-0 items-center justify-center"
                            style={{ color: fileVisual.color }}
                          >
                            {fileVisual.icon}
                          </div>
                        );
                      })()}
                      <div className="flex min-w-0 flex-1 items-baseline gap-2">
                        <span
                          className="min-w-0 shrink truncate text-[13px] font-medium"
                          style={{ color: "var(--cs-text-primary)" }}
                        >
                          {highlightMatch(item.name, query)}
                        </span>
                        <span
                          className="min-w-0 flex-1 truncate text-[11px]"
                          style={{ color: "var(--cs-text-tertiary)" }}
                        >
                          {highlightMatch(item.parentPath, query)}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            <div
              className="flex h-7 items-center justify-between gap-3 border-t px-2.5 text-[10px]"
              style={{
                borderColor: "var(--cs-border-card, var(--cs-border))",
                color: "var(--cs-text-tertiary)",
              }}
            >
              <span className="min-w-0 flex-1 truncate">
                {visibleItems[activeIndex]?.relativePath ??
                  (query.trim() ? t("titleBar.quickSearchResults") : t("titleBar.quickSearchRecent"))}
              </span>
              <span className="flex shrink-0 items-center gap-3">
                {searching ? <Spin size="small" /> : null}
                <span>{t("titleBar.quickSearchKeyboardHint")}</span>
              </span>
            </div>
          </div>
        </div>
      </Modal>
    </>
  );
}

export default TitleBarQuickSearch;
