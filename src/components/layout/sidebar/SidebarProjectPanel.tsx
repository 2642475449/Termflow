import { Button, Checkbox, Dropdown, Empty, Input, Modal, Spin, Tooltip, message } from "antd";
import type { InputRef, MenuProps } from "antd";
import {
  CompressOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  ExportOutlined,
  FileOutlined,
  FolderOpenFilled,
  FolderOutlined,
  ReloadOutlined,
  RightOutlined,
  SearchOutlined,
  SnippetsOutlined,
} from "@ant-design/icons";
import { open as openDirectoryDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef, useState, useDeferredValue } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import {
  copyExternalEntry,
  copyProjectEntries,
  createProjectDirectory,
  createProjectFile,
  deleteProjectEntry,
  listProjectDirectory,
  renameProjectEntry,
  searchProjectEntries,
} from "@/lib/api";
import {
  EXPLORER_REVEAL_PATH_EVENT,
  EXPLORER_SELECT_ALL_EVENT,
  takePendingExplorerRevealPath,
} from "@/lib/explorer";
import type { ExplorerRevealPathDetail } from "@/lib/explorer";
import { getFileIcon } from "@/lib/fileIcon";
import { openGlobalTextSearch } from "@/lib/globalSearch";
import { useAppStore } from "@/store";
import type { FileTreeEntry, FileTreeEntryKind } from "@/types";
import { useTranslation } from "react-i18next";

interface ProjectRef {
  name: string;
  path: string;
}

interface SidebarProjectPanelProps {
  currentProject: ProjectRef | null;
  noProjectText: string;
  panelTitle: string;
  filterPlaceholderText: string;
  filterNoResultsText: string;
  refreshText: string;
  loadingText: string;
  emptyFolderText: string;
  openInManagerText: string;
  openInAssociatedAppText: string;
  copyRelativePathText: string;
  copyAbsolutePathText: string;
  copyPathSuccessText: string;
  onOpenInFileManager: (path: string) => void;
  onOpenInAssociatedApp: (path: string) => void;
  onOpenFile: (path: string, options?: { preview?: boolean }) => void;
}

interface ResourceTreeNode {
  entry: FileTreeEntry;
  isExpanded: boolean;
  isLoadingChildren: boolean;
  children: ResourceTreeNode[];
}

interface SearchTreeNode {
  name: string;
  path: string;
  kind: FileTreeEntryKind;
  hasChildren: boolean;
  children: SearchTreeNode[];
}

interface PendingCreatedResource {
  path: string;
  kind: FileTreeEntryKind;
}

interface PendingExternalCopy {
  sourcePaths: string[];
  destinationDirectory: string;
  newName: string;
  openAfterCopy: boolean;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

function isPathInsideRoot(rootPath: string, targetPath: string): boolean {
  const normalizedRoot = normalizePath(rootPath);
  const normalizedTarget = normalizePath(targetPath);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}

function joinPath(base: string, parts: string[]): string {
  const separator = base.includes("\\") ? "\\" : "/";
  const normalizedBase = base.replace(/[\\/]+$/, "");
  if (parts.length === 0) return normalizedBase;
  return [normalizedBase, ...parts].join(separator);
}

function buildRelativePath(rootPath: string, targetPath: string): string {
  const normalizedRoot = normalizePath(rootPath);
  const normalizedTarget = normalizePath(targetPath);
  if (normalizedRoot === normalizedTarget) {
    return ".";
  }

  const prefix = `${normalizedRoot}/`;
  if (normalizedTarget.startsWith(prefix)) {
    return normalizedTarget.slice(prefix.length);
  }

  return targetPath;
}

function buildBreadcrumbs(rootName: string, rootPath: string, selectedPath: string) {
  const normalizedRoot = normalizePath(rootPath);
  const normalizedSelected = normalizePath(selectedPath);
  const relative = normalizedSelected === normalizedRoot
    ? ""
    : normalizedSelected.startsWith(`${normalizedRoot}/`)
      ? normalizedSelected.slice(normalizedRoot.length + 1)
      : "";

  const segments = relative ? relative.split("/").filter(Boolean) : [];
  const items = [{ label: rootName, path: rootPath }];

  for (let index = 0; index < segments.length; index += 1) {
    items.push({
      label: segments[index],
      path: joinPath(rootPath, segments.slice(0, index + 1)),
    });
  }

  return items;
}

function getDirectoryPathsToExpand(rootPath: string, targetPath: string, targetIsDirectory: boolean): string[] {
  const normalizedRoot = normalizePath(rootPath);
  const normalizedTarget = normalizePath(targetPath);
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}/`)) {
    return [];
  }

  const relative = normalizedTarget === normalizedRoot ? "" : normalizedTarget.slice(normalizedRoot.length + 1);
  const segments = relative ? relative.split("/").filter(Boolean) : [];
  const directorySegments = targetIsDirectory ? segments : segments.slice(0, -1);

  return directorySegments.map((_, index) =>
    joinPath(rootPath, directorySegments.slice(0, index + 1))
  );
}

function getParentPath(rootPath: string, targetPath: string): string {
  const normalizedRoot = normalizePath(rootPath);
  const normalizedTarget = normalizePath(targetPath);
  if (normalizedTarget === normalizedRoot) {
    return rootPath;
  }

  const trimmed = targetPath.replace(/[\\/]+$/, "");
  const lastSeparatorIndex = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (lastSeparatorIndex <= 0) {
    return rootPath;
  }

  const parentPath = trimmed.slice(0, lastSeparatorIndex);
  return normalizePath(parentPath).startsWith(normalizedRoot) ? parentPath : rootPath;
}

function getCreateTargetDirectory(rootPath: string, entry: FileTreeEntry): string {
  return entry.kind === "directory" ? entry.path : getParentPath(rootPath, entry.path);
}

function getDefaultCreateDirectory(
  rootPath: string,
  selectedPath: string | null,
  isSelectedDirectory: boolean
): string {
  if (!selectedPath) {
    return rootPath;
  }

  if (normalizePath(selectedPath) === normalizePath(rootPath) || isSelectedDirectory) {
    return selectedPath;
  }

  return getParentPath(rootPath, selectedPath);
}

function collectAncestorPaths(rootPath: string, targetPath: string): string[] {
  const normalizedRoot = normalizePath(rootPath);
  const normalizedTarget = normalizePath(targetPath);
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}/`)) {
    return [normalizedRoot];
  }

  const relative = normalizedTarget === normalizedRoot ? "" : normalizedTarget.slice(normalizedRoot.length + 1);
  const segments = relative ? relative.split("/").filter(Boolean) : [];
  const paths = [normalizedRoot];

  for (let index = 0; index < segments.length; index += 1) {
    paths.push(normalizePath(joinPath(rootPath, segments.slice(0, index + 1))));
  }

  return paths;
}

function buildSearchRelevantPaths(rootPath: string, entries: FileTreeEntry[]): Set<string> {
  const paths = new Set<string>([normalizePath(rootPath)]);

  for (const entry of entries) {
    for (const path of collectAncestorPaths(rootPath, entry.path)) {
      paths.add(path);
    }
  }

  return paths;
}

function getBaseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function isProbablyFilePath(path: string): boolean {
  const name = getBaseName(path);
  return name.includes(".") && !name.endsWith(".");
}

function getExternalCopyTargetNames(copy: PendingExternalCopy): string[] {
  if (copy.sourcePaths.length === 1) {
    return [copy.newName.trim()];
  }

  return copy.sourcePaths.map((path) => getBaseName(path));
}

function isExplicitExternalCopyRename(copy: PendingExternalCopy): boolean {
  return copy.sourcePaths.length === 1 && copy.newName.trim() !== getBaseName(copy.sourcePaths[0] ?? "");
}

function isInvalidEntryName(name: string): boolean {
  const trimmedName = name.trim();
  return !trimmedName || trimmedName === "." || trimmedName === ".." || /[\\/]/.test(trimmedName);
}

function buildDefaultResourceName(type: "file" | "directory", attempt: number): string {
  const baseName = type === "file" ? "untitled" : "new-folder";
  if (attempt === 0) {
    return baseName;
  }

  return `${baseName}-${attempt}`;
}

function buildSearchTree(rootPath: string, entries: FileTreeEntry[]): ResourceTreeNode[] {
  const nodeMap = new Map<string, SearchTreeNode>();
  const roots: SearchTreeNode[] = [];

  for (const entry of entries) {
    const relativePath = buildRelativePath(rootPath, entry.path);
    const segments = relativePath === "." ? [] : relativePath.split(/[\\/]/).filter(Boolean);
    let currentChildren = roots;

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const currentPath = joinPath(rootPath, segments.slice(0, index + 1));
      const isLeaf = index === segments.length - 1;
      const existing = nodeMap.get(currentPath);

      if (existing) {
        currentChildren = existing.children;
        continue;
      }

      const nextNode: SearchTreeNode = {
        name: segment,
        path: currentPath,
        kind: isLeaf ? entry.kind : "directory",
        hasChildren: !isLeaf || entry.hasChildren,
        children: [],
      };

      nodeMap.set(currentPath, nextNode);
      currentChildren.push(nextNode);
      currentChildren = nextNode.children;
    }
  }

  const sortNodes = (nodes: SearchTreeNode[]) => {
    nodes.sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === "directory" ? -1 : 1;
      }
      return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    });

    for (const node of nodes) {
      sortNodes(node.children);
    }
  };

  sortNodes(roots);

  const convertNodes = (nodes: SearchTreeNode[]): ResourceTreeNode[] =>
    nodes.map((node) => ({
      entry: {
        name: node.name,
        path: node.path,
        kind: node.kind,
        hasChildren: node.hasChildren,
      },
      isExpanded: node.children.length > 0,
      isLoadingChildren: false,
      children: convertNodes(node.children),
    }));

  return convertNodes(roots);
}

function collectVisiblePaths(nodes: ResourceTreeNode[]): string[] {
  const paths: string[] = [];

  const visit = (items: ResourceTreeNode[]) => {
    for (const node of items) {
      paths.push(node.entry.path);
      if (node.entry.kind === "directory" && node.isExpanded && node.children.length > 0) {
        visit(node.children);
      }
    }
  };

  visit(nodes);
  return paths;
}

function highlightText(text: string, keyword: string): ReactNode {
  const query = keyword.trim();
  if (!query) {
    return text;
  }

  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(`(${escapedQuery})`, "ig");
  const parts = text.split(matcher);

  if (parts.length === 1) {
    return text;
  }

  return parts.map((part, index) =>
    part.toLowerCase() === query.toLowerCase() ? (
      <mark key={`${part}-${index}`} className="app-file-tree-highlight">
        {part}
      </mark>
    ) : (
      <span key={`${part}-${index}`}>{part}</span>
    )
  );
}

function SidebarProjectPanel({
  currentProject,
  noProjectText,
  panelTitle,
  filterPlaceholderText,
  filterNoResultsText,
  refreshText,
  loadingText,
  emptyFolderText,
  openInManagerText,
  openInAssociatedAppText,
  copyRelativePathText,
  copyAbsolutePathText,
  copyPathSuccessText,
  onOpenInFileManager,
  onOpenInAssociatedApp,
  onOpenFile,
}: SidebarProjectPanelProps) {
  const { t } = useTranslation();
  const [rootEntries, setRootEntries] = useState<FileTreeEntry[]>([]);
  const [loadedDirectories, setLoadedDirectories] = useState<Record<string, FileTreeEntry[]>>({});
  const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>({});
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [loadingRoot, setLoadingRoot] = useState(false);
  const [loadingDirectories, setLoadingDirectories] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [filterValue, setFilterValue] = useState("");
  const deferredFilterValue = useDeferredValue(filterValue);
  const [searchResults, setSearchResults] = useState<FileTreeEntry[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [renamingEntry, setRenamingEntry] = useState<FileTreeEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameSubmitting, setRenameSubmitting] = useState(false);
  const [deletingEntries, setDeletingEntries] = useState<FileTreeEntry[]>([]);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [pasteSubmitting, setPasteSubmitting] = useState(false);
  const [clipboardPaths, setClipboardPaths] = useState<string[]>([]);
  const [pendingCreatedResource, setPendingCreatedResource] = useState<PendingCreatedResource | null>(null);
  const [pendingExternalCopy, setPendingExternalCopy] = useState<PendingExternalCopy | null>(null);
  const [externalCopySubmitting, setExternalCopySubmitting] = useState(false);
  const renameInputRef = useRef<InputRef | null>(null);
  const renameCommitInFlightRef = useRef(false);
  const suppressNextClickPathRef = useRef<string | null>(null);
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const [isExternalDragOver, setIsExternalDragOver] = useState(false);
  const treeContainerRef = useRef<HTMLDivElement | null>(null);
  const setResourceDragState = useAppStore((s) => s.setResourceDragState);

  const rootLabel = useMemo(() => currentProject?.name ?? "", [currentProject?.name]);
  const normalizedSelectedPaths = useMemo(
    () => new Set(selectedPaths.map((path) => normalizePath(path))),
    [selectedPaths]
  );

  const selectOnlyPath = useCallback((path: string | null) => {
    setSelectedPath(path);
    setSelectedPaths(path ? [path] : []);
  }, []);

  const loadDirectory = useCallback(
    async (directoryPath?: string | null) => {
      if (!currentProject) return;
      const requestPath = directoryPath ?? currentProject.path;

      if (directoryPath) {
        setLoadingDirectories((prev) => ({ ...prev, [requestPath]: true }));
      } else {
        setLoadingRoot(true);
      }

      try {
        const listing = await listProjectDirectory(currentProject.path, directoryPath ?? null);
        setError(null);

        if (directoryPath) {
          setLoadedDirectories((prev) => ({
            ...prev,
            [listing.directoryPath]: listing.entries,
          }));
        } else {
          setRootEntries(listing.entries);
          setLoadedDirectories({ [listing.directoryPath]: listing.entries });
          setSelectedPath((prev) => prev ?? listing.rootPath);
        }
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      } finally {
        if (directoryPath) {
          setLoadingDirectories((prev) => ({ ...prev, [requestPath]: false }));
        } else {
          setLoadingRoot(false);
        }
      }
    },
    [currentProject]
  );

  useEffect(() => {
    if (!currentProject) return;
    setExpandedPaths({});
    setLoadedDirectories({});
    setRootEntries([]);
    setSelectedPaths([currentProject.path]);
    setSelectedPath(currentProject.path);
    setFilterValue("");
    setSearchResults([]);
    void loadDirectory(null);
  }, [currentProject, loadDirectory]);

  useEffect(() => {
    if (!selectedPath) {
      setSelectedPaths((prev) => (prev.length > 0 ? [] : prev));
      return;
    }

    const normalizedSelectedPath = normalizePath(selectedPath);
    setSelectedPaths((prev) => {
      if (prev.length > 1 && prev.some((path) => normalizePath(path) === normalizedSelectedPath)) {
        return prev;
      }
      if (prev.length === 1 && normalizePath(prev[0]) === normalizedSelectedPath) {
        return prev;
      }
      return [selectedPath];
    });
  }, [selectedPath]);

  useEffect(() => {
    if (!currentProject) return;
    const query = deferredFilterValue.trim();
    if (!query) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }

    let cancelled = false;
    setSearchLoading(true);

    void searchProjectEntries(currentProject.path, query)
      .then((results) => {
        if (!cancelled) {
          setSearchResults(results);
          setError(null);
        }
      })
      .catch((nextError) => {
        if (!cancelled) {
          setSearchResults([]);
          setError(nextError instanceof Error ? nextError.message : String(nextError));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setSearchLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentProject, deferredFilterValue]);

  const revealPath = useCallback(
    async (targetPath: string, targetIsDirectory = false) => {
      if (!currentProject) return;
      const pathsToExpand = getDirectoryPathsToExpand(currentProject.path, targetPath, targetIsDirectory);

      for (const path of pathsToExpand) {
        if (!loadedDirectories[path]) {
          await loadDirectory(path);
        }
      }

      setExpandedPaths((prev) => {
        const next = { ...prev };
        for (const path of pathsToExpand) {
          next[path] = true;
        }
        return next;
      });
      setSelectedPath(targetPath);
    },
    [currentProject, loadedDirectories, loadDirectory]
  );

  const refreshProjectView = useCallback(
    async (targetPath?: string | null, targetIsDirectory = false) => {
      if (!currentProject) return;

      setExpandedPaths({});
      setLoadedDirectories({});
      setRootEntries([]);
      await loadDirectory(null);

      if (targetPath) {
        const pathsToExpand = getDirectoryPathsToExpand(currentProject.path, targetPath, targetIsDirectory);
        for (const path of pathsToExpand) {
          await loadDirectory(path);
        }
        setExpandedPaths(() => {
          const next: Record<string, boolean> = {};
          for (const path of pathsToExpand) {
            next[path] = true;
          }
          return next;
        });
        setSelectedPath(targetPath);
      } else {
        setSelectedPath(currentProject.path);
      }

      const query = filterValue.trim();
      if (!query) {
        setSearchResults([]);
        setSearchLoading(false);
        return;
      }

      setSearchLoading(true);
      try {
        const results = await searchProjectEntries(currentProject.path, query);
        setSearchResults(results);
        setError(null);
      } catch (nextError) {
        setSearchResults([]);
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      } finally {
        setSearchLoading(false);
      }
    },
    [currentProject, filterValue, loadDirectory]
  );

  useEffect(() => {
    const handleRevealPath = (event: Event) => {
      const detail = (event as CustomEvent<ExplorerRevealPathDetail>).detail;
      if (!detail?.path) return;
      void revealPath(detail.path, detail.kind === "directory");
    };

    window.addEventListener(EXPLORER_REVEAL_PATH_EVENT, handleRevealPath as EventListener);
    const pendingDetail = takePendingExplorerRevealPath();
    if (pendingDetail?.path) {
      void revealPath(pendingDetail.path, pendingDetail.kind === "directory");
    }
    return () => {
      window.removeEventListener(EXPLORER_REVEAL_PATH_EVENT, handleRevealPath as EventListener);
    };
  }, [revealPath]);

  useEffect(() => {
    if (!selectedPath) return;
    const frame = window.requestAnimationFrame(() => {
      const selectedRow = Array.from(
        treeContainerRef.current?.querySelectorAll<HTMLElement>(".app-file-tree-row[data-path]") ?? []
      ).find((row) => normalizePath(row.dataset.path ?? "") === normalizePath(selectedPath));
      selectedRow?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedPath]);

  const handleRefresh = useCallback(() => {
    if (!currentProject) return;
    setExpandedPaths({});
    void loadDirectory(null);
  }, [currentProject, loadDirectory]);

  const handleCollapseAll = useCallback(() => {
    setExpandedPaths({});
  }, []);

  const handleToggleDirectory = useCallback(
    async (entry: FileTreeEntry) => {
      if (!!expandedPaths[entry.path]) {
        setSelectedPath(entry.path);
        setExpandedPaths((prev) => ({ ...prev, [entry.path]: false }));
        return;
      }

      await revealPath(entry.path, true);
    },
    [expandedPaths, revealPath]
  );

  const buildVisibleTree = useCallback(
    (entries: FileTreeEntry[]): ResourceTreeNode[] =>
      entries.map((entry) => {
        const isExpanded = !!expandedPaths[entry.path];
        const children = entry.kind === "directory" && isExpanded
          ? buildVisibleTree(loadedDirectories[entry.path] ?? [])
          : [];

        return {
          entry,
          isExpanded,
          isLoadingChildren: !!loadingDirectories[entry.path],
          children,
        };
      }),
    [expandedPaths, loadedDirectories, loadingDirectories]
  );

  const visibleTree = useMemo(() => buildVisibleTree(rootEntries), [buildVisibleTree, rootEntries]);

  const searchTree = useMemo(
    () => (currentProject ? buildSearchTree(currentProject.path, searchResults) : []),
    [currentProject, searchResults]
  );

  const breadcrumbs = useMemo(
    () => buildBreadcrumbs(rootLabel, currentProject?.path ?? "", selectedPath ?? currentProject?.path ?? ""),
    [currentProject?.path, rootLabel, selectedPath]
  );

  const isSearchMode = filterValue.trim().length > 0;
  const visibleSelectablePaths = useMemo(
    () => collectVisiblePaths(isSearchMode ? searchTree : visibleTree),
    [isSearchMode, searchTree, visibleTree]
  );
  const projectRootPath = currentProject?.path ?? "";
  const knownEntries = useMemo(
    () => [
      ...rootEntries,
      ...Object.values(loadedDirectories).flat(),
      ...searchResults,
    ],
    [loadedDirectories, rootEntries, searchResults]
  );
  const externalCopyValidation = useMemo(() => {
    if (!pendingExternalCopy) {
      return {
        targetNames: [] as string[],
        conflictNames: [] as string[],
        hasBlankName: false,
        hasInvalidName: false,
      };
    }

    const targetNames = getExternalCopyTargetNames(pendingExternalCopy);
    const destinationDirectory = pendingExternalCopy.destinationDirectory.trim();
    const knownPaths = new Set(knownEntries.map((entry) => normalizePath(entry.path)));
    const conflictNames = isExplicitExternalCopyRename(pendingExternalCopy)
      ? targetNames.filter((name) => {
          if (!name || !destinationDirectory) return false;
          return knownPaths.has(normalizePath(joinPath(destinationDirectory, [name])));
        })
      : [];

    return {
      targetNames,
      conflictNames,
      hasBlankName: targetNames.some((name) => name.trim().length === 0),
      hasInvalidName: pendingExternalCopy.sourcePaths.length === 1 && isInvalidEntryName(pendingExternalCopy.newName),
    };
  }, [knownEntries, pendingExternalCopy]);
  const selectedEntries = useMemo(() => {
    const entriesByPath = new Map(
      knownEntries.map((entry) => [normalizePath(entry.path), entry] as const)
    );

    return selectedPaths
      .map((path) => entriesByPath.get(normalizePath(path)))
      .filter((entry): entry is FileTreeEntry => !!entry);
  }, [knownEntries, selectedPaths]);
  const actionableSelectedEntries = useMemo(
    () => selectedEntries.filter((entry) => normalizePath(entry.path) !== normalizePath(projectRootPath)),
    [projectRootPath, selectedEntries]
  );
  const hasClipboardEntries = clipboardPaths.length > 0;
  const selectedEntryKind = useMemo(() => {
    if (!selectedPath || normalizePath(selectedPath) === normalizePath(projectRootPath)) {
      return "directory";
    }

    return (
      knownEntries.find((entry) => normalizePath(entry.path) === normalizePath(selectedPath))?.kind ?? "file"
    );
  }, [knownEntries, projectRootPath, selectedPath]);
  const searchRelevantPaths = useMemo(
    () => buildSearchRelevantPaths(projectRootPath, searchResults),
    [projectRootPath, searchResults]
  );
  const backgroundSelectedPath = useMemo(() => {
    if (!isSearchMode || !selectedPath) {
      return selectedPath;
    }

    return searchRelevantPaths.has(normalizePath(selectedPath)) ? selectedPath : projectRootPath;
  }, [isSearchMode, projectRootPath, searchRelevantPaths, selectedPath]);
  const backgroundCreateTargetPath = useMemo(
    () => getDefaultCreateDirectory(projectRootPath, backgroundSelectedPath, selectedEntryKind === "directory"),
    [backgroundSelectedPath, projectRootPath, selectedEntryKind]
  );
  const canCopySelection = actionableSelectedEntries.length > 0 && !renameSubmitting;
  const canDeleteSelection = actionableSelectedEntries.length > 0 && !deleteSubmitting && !renameSubmitting;
  const canPasteEntries = hasClipboardEntries && !pasteSubmitting && !renameSubmitting;

  const handleSelectAllVisible = useCallback(() => {
    const treeContainer = treeContainerRef.current;
    const activeElement = document.activeElement;
    const isTreeFocused =
      !!treeContainer &&
      activeElement instanceof HTMLElement &&
      (activeElement === treeContainer || treeContainer.contains(activeElement));

    if (!isTreeFocused || visibleSelectablePaths.length === 0) {
      return;
    }

    setSelectedPaths(visibleSelectablePaths);
    setSelectedPath((prev) => {
      if (prev && visibleSelectablePaths.some((path) => normalizePath(path) === normalizePath(prev))) {
        return prev;
      }
      return visibleSelectablePaths[0] ?? prev;
    });
  }, [visibleSelectablePaths]);

  useEffect(() => {
    const handleSelectAll = () => {
      handleSelectAllVisible();
    };

    window.addEventListener(EXPLORER_SELECT_ALL_EVENT, handleSelectAll);
    return () => {
      window.removeEventListener(EXPLORER_SELECT_ALL_EVENT, handleSelectAll);
    };
  }, [handleSelectAllVisible]);

  useEffect(() => {
    if (!currentProject) return;

    const currentWindow = getCurrentWindow();
    const dropPromise = currentWindow.onDragDropEvent((event) => {
      if (event.payload.type === "leave") {
        setIsExternalDragOver(false);
        setDragOverPath(null);
        return;
      }

      // 将物理像素转换为 CSS 像素
      const pos = event.payload.position;
      const cssX = pos.x / window.devicePixelRatio;
      const cssY = pos.y / window.devicePixelRatio;

      // 使用 elementFromPoint 精确检测鼠标下方的元素
      const element = document.elementFromPoint(cssX, cssY);
      const treeContainer = treeContainerRef.current;
      const isInsideSidebar = element && treeContainer?.contains(element);

      if (!isInsideSidebar) {
        if (event.payload.type !== "drop") {
          setIsExternalDragOver(false);
          setDragOverPath(null);
        }
        return;
      }

      if (event.payload.type === "enter" || event.payload.type === "over") {
        setIsExternalDragOver(true);

        // 向上查找最近的 .app-file-tree-row 元素
        const row = element!.closest(".app-file-tree-row");
        let foundPath: string | null = null;

        if (row) {
          const dataPath = row.getAttribute("data-path");
          if (dataPath) {
            const entry = knownEntries.find(
              (e) => normalizePath(e.path) === normalizePath(dataPath)
            );
            if (entry?.kind === "directory") {
              foundPath = dataPath;
            } else if (entry) {
              foundPath = getParentPath(projectRootPath, entry.path);
            }
          }
        }
        setDragOverPath(foundPath);
        return;
      }

      if (event.payload.type === "drop") {
        setIsExternalDragOver(false);
        const targetDir = dragOverPath ?? currentProject.path;
        setDragOverPath(null);

        const paths = event.payload.paths;
        if (paths.length === 0) return;

        const firstName = getBaseName(paths[0] ?? "");
        setPendingExternalCopy({
          sourcePaths: paths,
          destinationDirectory: targetDir,
          newName: firstName,
          openAfterCopy: paths.length === 1 && isProbablyFilePath(firstName),
        });
      }
    });

    return () => {
      dropPromise.then((unlisten) => unlisten());
    };
  }, [currentProject, dragOverPath, knownEntries, projectRootPath, refreshProjectView, t]);

  useEffect(() => {
    if (!renamingEntry) {
      renameCommitInFlightRef.current = false;
      return;
    }

    const timer = window.setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [renamingEntry]);

  const handleOpenRename = useCallback((entry: FileTreeEntry) => {
    setPendingCreatedResource(null);
    setSelectedPath(entry.path);
    setRenamingEntry(entry);
    setRenameValue(entry.name);
  }, []);

  const handleCancelRename = useCallback(() => {
    if (renameSubmitting) return;
    renameCommitInFlightRef.current = false;
    setPendingCreatedResource(null);
    setRenamingEntry(null);
    setRenameValue("");
  }, [renameSubmitting]);

  const handleConfirmRename = useCallback(async () => {
    if (!currentProject || !renamingEntry || renameCommitInFlightRef.current) return;

    renameCommitInFlightRef.current = true;
    setRenameSubmitting(true);
    try {
      const shouldOpenCreatedFile =
        pendingCreatedResource?.kind === "file" &&
        normalizePath(pendingCreatedResource.path) === normalizePath(renamingEntry.path);
      const nextPath = await renameProjectEntry(currentProject.path, renamingEntry.path, renameValue);
      setPendingCreatedResource(null);
      setRenamingEntry(null);
      setRenameValue("");
      await refreshProjectView(nextPath, renamingEntry.kind === "directory");
      message.success(t("sidebar.resourceRenamed"));
      if (shouldOpenCreatedFile) {
        onOpenFile(nextPath);
      }
    } catch (nextError) {
      message.error(
        nextError instanceof Error ? nextError.message : t("sidebar.resourceRenameFailed")
      );
    } finally {
      renameCommitInFlightRef.current = false;
      setRenameSubmitting(false);
    }
  }, [currentProject, onOpenFile, pendingCreatedResource, refreshProjectView, renameValue, renamingEntry, t]);

  const handleRequestDeleteEntries = useCallback((entries: FileTreeEntry[]) => {
    if (entries.length === 0) return;
    setDeletingEntries(entries);
  }, []);

  const handleCopyEntries = useCallback(
    (entries: FileTreeEntry[]) => {
      const nextPaths = Array.from(new Set(entries.map((entry) => entry.path)));
      if (nextPaths.length === 0) return;
      setClipboardPaths(nextPaths);
      message.success(t("sidebar.selectionCopied", { count: nextPaths.length }));
    },
    [t]
  );

  const handleStartResourceDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>, entry: FileTreeEntry) => {
      if (event.button !== 0 || !currentProject || renamingEntry) return;

      const dragEntries =
        selectedEntries.some((selected) => normalizePath(selected.path) === normalizePath(entry.path))
          ? selectedEntries
          : [entry];
      if (dragEntries.length === 0) return;

      const startedAt = Date.now();
      const startX = event.clientX;
      const startY = event.clientY;
      let dragging = false;
      let lastX = startX;
      let lastY = startY;
      let previousUserSelect = "";

      const nextState = (x: number, y: number, phase: "dragging" | "dropping") => ({
        type: "agent-resource" as const,
        projectPath: currentProject.path,
        entries: dragEntries.map((item) => ({
          path: item.path,
          kind: item.kind,
          name: item.name,
        })),
        x,
        y,
        phase,
        startedAt,
      });

      const cleanup = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        window.removeEventListener("pointercancel", handleCancel);
        if (dragging) {
          document.body.style.userSelect = previousUserSelect;
        }
      };

      const beginDragging = () => {
        if (dragging) return;
        dragging = true;
        previousUserSelect = document.body.style.userSelect;
        document.body.style.userSelect = "none";
        suppressNextClickPathRef.current = entry.path;
      };

      const handleMove = (moveEvent: PointerEvent) => {
        lastX = moveEvent.clientX;
        lastY = moveEvent.clientY;
        const distance = Math.hypot(lastX - startX, lastY - startY);
        if (!dragging && distance < 6) return;

        beginDragging();
        moveEvent.preventDefault();
        setResourceDragState(nextState(lastX, lastY, "dragging"));
      };

      const handleUp = (upEvent: PointerEvent) => {
        cleanup();
        if (!dragging) return;

        lastX = upEvent.clientX;
        lastY = upEvent.clientY;
        setResourceDragState(nextState(lastX, lastY, "dropping"));
        window.setTimeout(() => {
          const current = useAppStore.getState().resourceDragState;
          if (current?.type === "agent-resource" && current.startedAt === startedAt) {
            setResourceDragState(null);
          }
        }, 250);
      };

      const handleCancel = () => {
        cleanup();
        if (dragging) {
          setResourceDragState(null);
        }
      };

      window.addEventListener("pointermove", handleMove, { passive: false });
      window.addEventListener("pointerup", handleUp);
      window.addEventListener("pointercancel", handleCancel);
    },
    [currentProject, renamingEntry, selectedEntries, setResourceDragState]
  );

  const handlePasteEntries = useCallback(
    async (destinationDirectory: string) => {
      if (!currentProject || clipboardPaths.length === 0 || pasteSubmitting) return;

      setPasteSubmitting(true);
      try {
        const pastedPaths = await copyProjectEntries(currentProject.path, clipboardPaths, destinationDirectory);
        await refreshProjectView(destinationDirectory, true);
        if (pastedPaths.length > 0) {
          setSelectedPaths(pastedPaths);
          setSelectedPath(pastedPaths[0] ?? destinationDirectory);
        } else {
          selectOnlyPath(destinationDirectory);
        }
        message.success(t("sidebar.resourcePasteSuccess", { count: pastedPaths.length }));
      } catch (nextError) {
        message.error(
          nextError instanceof Error ? nextError.message : t("sidebar.resourcePasteFailed")
        );
      } finally {
        setPasteSubmitting(false);
      }
    },
    [clipboardPaths, currentProject, pasteSubmitting, refreshProjectView, selectOnlyPath, t]
  );

  const handleChooseExternalCopyDirectory = useCallback(async () => {
    if (!pendingExternalCopy) return;

    const selected = await openDirectoryDialog({
      directory: true,
      multiple: false,
      defaultPath: pendingExternalCopy.destinationDirectory,
      title: t("sidebar.externalCopyChooseDirectory", { defaultValue: "选择目标目录" }),
    });

    if (typeof selected !== "string") return;

    setPendingExternalCopy((current) =>
      current ? { ...current, destinationDirectory: selected } : current
    );
  }, [pendingExternalCopy, t]);

  const handleConfirmExternalCopy = useCallback(async () => {
    if (!currentProject || !pendingExternalCopy || externalCopySubmitting) return;

    const destinationDirectory = pendingExternalCopy.destinationDirectory.trim();
    const nextName = pendingExternalCopy.newName.trim();
    const isSingleItem = pendingExternalCopy.sourcePaths.length === 1;
    const shouldRenameCopiedSingle = isExplicitExternalCopyRename(pendingExternalCopy);
    const destinationInsideProject = isPathInsideRoot(currentProject.path, destinationDirectory);

    if (!destinationDirectory) {
      message.warning(t("sidebar.externalCopyDestinationRequired", { defaultValue: "请输入目标目录" }));
      return;
    }

    if (isSingleItem && !nextName) {
      message.warning(t("sidebar.externalCopyNameRequired", { defaultValue: "请输入新名称" }));
      return;
    }

    if (isSingleItem && isInvalidEntryName(nextName)) {
      message.warning(t("sidebar.externalCopyInvalidName", { defaultValue: "名称不能包含路径分隔符，也不能是 . 或 .." }));
      return;
    }

    if (externalCopyValidation.conflictNames.length > 0) {
      message.warning(
        isSingleItem
          ? t("sidebar.externalCopyNameExists", { defaultValue: "目标目录已存在同名文件，请修改新名称后再确认" })
          : t("sidebar.externalCopyNamesExist", {
              defaultValue: "目标目录已存在同名项目：{{names}}",
              names: externalCopyValidation.conflictNames.join(", "),
            })
      );
      return;
    }

    setExternalCopySubmitting(true);
    try {
      if (shouldRenameCopiedSingle && destinationInsideProject) {
        const destinationListing = await listProjectDirectory(currentProject.path, destinationDirectory);
        const nameAlreadyExists = destinationListing.entries.some(
          (entry) => entry.name.toLocaleLowerCase() === nextName.toLocaleLowerCase()
        );
        if (nameAlreadyExists) {
          message.warning(t("sidebar.externalCopyNameExists", { defaultValue: "目标目录已存在同名文件，请修改新名称后再确认" }));
          return;
        }
      }

      const copiedPaths = await copyExternalEntry(
        currentProject.path,
        pendingExternalCopy.sourcePaths,
        destinationDirectory,
        shouldRenameCopiedSingle ? nextName : null
      );

      let finalPaths = copiedPaths;
      if (destinationInsideProject) {
        await refreshProjectView(destinationDirectory, true);
        if (finalPaths.length > 0) {
          setSelectedPaths(finalPaths);
          setSelectedPath(finalPaths[0] ?? destinationDirectory);
        } else {
          selectOnlyPath(destinationDirectory);
        }
      }

      if (
        pendingExternalCopy.openAfterCopy &&
        destinationInsideProject &&
        finalPaths.length === 1 &&
        finalPaths[0] &&
        isProbablyFilePath(finalPaths[0])
      ) {
        onOpenFile(finalPaths[0]);
      }

      setPendingExternalCopy(null);
      message.success(t("sidebar.copyExternalSuccess", { count: finalPaths.length }));
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("sidebar.copyExternalFailed"));
    } finally {
      setExternalCopySubmitting(false);
    }
  }, [
    currentProject,
    externalCopySubmitting,
    externalCopyValidation.conflictNames,
    onOpenFile,
    pendingExternalCopy,
    refreshProjectView,
    selectOnlyPath,
    t,
  ]);

  const handleCreateResource = useCallback(
    async (type: "file" | "directory", parentPath: string) => {
      if (!currentProject || createSubmitting) return;

      setCreateSubmitting(true);
      try {
        let nextPath = "";
        let createdName = "";

        for (let attempt = 0; attempt < 100; attempt += 1) {
          const candidateName = buildDefaultResourceName(type, attempt);

          try {
            nextPath =
              type === "file"
                ? await createProjectFile(currentProject.path, parentPath, candidateName)
                : await createProjectDirectory(currentProject.path, parentPath, candidateName);
            createdName = candidateName;
            break;
          } catch (nextError) {
            const messageText = nextError instanceof Error ? nextError.message : String(nextError);
            if (!messageText.includes("同名文件或文件夹已存在")) {
              throw nextError;
            }
          }
        }

        if (!nextPath) {
          throw new Error(type === "file" ? t("sidebar.resourceFileCreateFailed") : t("sidebar.resourceFolderCreateFailed"));
        }

        await refreshProjectView(nextPath, type === "directory");
        const nextEntry: FileTreeEntry = {
          name: getBaseName(nextPath) || createdName,
          path: nextPath,
          kind: type === "file" ? "file" : "directory",
          hasChildren: false,
        };
        setPendingCreatedResource({ path: nextPath, kind: nextEntry.kind });
        setRenamingEntry(nextEntry);
        setRenameValue(nextEntry.name);
      } catch (nextError) {
        message.error(
          nextError instanceof Error
            ? nextError.message
            : type === "file"
            ? t("sidebar.resourceFileCreateFailed")
            : t("sidebar.resourceFolderCreateFailed")
        );
      } finally {
        setCreateSubmitting(false);
      }
    },
    [createSubmitting, currentProject, refreshProjectView, t]
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!currentProject || deletingEntries.length === 0) return;

    setDeleteSubmitting(true);
    try {
      for (const entry of deletingEntries) {
        await deleteProjectEntry(currentProject.path, entry.path);
      }
      setDeletingEntries([]);
      const fallbackPath =
        deletingEntries.length === 1
          ? getParentPath(currentProject.path, deletingEntries[0].path)
          : currentProject.path;
      await refreshProjectView(fallbackPath, true);
      selectOnlyPath(fallbackPath);
      message.success(t("sidebar.resourceDeleted"));
    } catch (nextError) {
      message.error(
        nextError instanceof Error ? nextError.message : t("sidebar.resourceDeleteFailed")
      );
    } finally {
      setDeleteSubmitting(false);
    }
  }, [currentProject, deletingEntries, refreshProjectView, selectOnlyPath, t]);

  const handleBackgroundMenuClick: NonNullable<MenuProps["onClick"]> = useCallback(
    ({ key, domEvent }) => {
      domEvent.preventDefault();
      domEvent.stopPropagation();
      selectOnlyPath(backgroundCreateTargetPath);

      if (key === "create-file") {
        void handleCreateResource("file", backgroundCreateTargetPath);
        return;
      }

      if (key === "create-folder") {
        void handleCreateResource("directory", backgroundCreateTargetPath);
        return;
      }

      if (key === "paste") {
        void handlePasteEntries(backgroundCreateTargetPath);
        return;
      }

      if (key === "refresh") {
        handleRefresh();
        return;
      }

      if (key === "open-current-directory") {
        onOpenInFileManager(backgroundCreateTargetPath);
        return;
      }

      if (key === "find-in-directory") {
        openGlobalTextSearch(backgroundCreateTargetPath);
      }
    },
    [backgroundCreateTargetPath, handleCreateResource, handlePasteEntries, handleRefresh, onOpenInFileManager, selectOnlyPath]
  );

  const backgroundMenuItems = useMemo<MenuProps["items"]>(
    () => [
      {
        key: "create-file",
        icon: <FileOutlined />,
        label: t("sidebar.createFile"),
      },
      {
        key: "create-folder",
        icon: <FolderOutlined />,
        label: t("sidebar.createFolder"),
      },
      {
        key: "paste",
        icon: <SnippetsOutlined />,
        label: t("common.paste"),
        disabled: !hasClipboardEntries || pasteSubmitting,
      },
      { type: "divider" },
      {
        key: "find-in-directory",
        icon: <SearchOutlined />,
        label: t("globalSearch.findInDirectory"),
      },
      {
        key: "refresh",
        icon: <ReloadOutlined />,
        label: refreshText,
      },
      {
        key: "open-current-directory",
        icon: <FolderOpenFilled />,
        label: t("sidebar.openCurrentDirectoryInManager"),
      },
    ],
    [hasClipboardEntries, pasteSubmitting, refreshText, t]
  );

  const renderNodes = useCallback(
    (nodes: ResourceTreeNode[], depth = 0, searchMode = false): ReactNode =>
      nodes.map((node) => {
        const { entry, isExpanded, isLoadingChildren, children } = node;
        const isDirectory = entry.kind === "directory";
        const isActive = selectedPath === entry.path;
        const isSelected = normalizedSelectedPaths.has(normalizePath(entry.path));
        const selectionCount = actionableSelectedEntries.length;
        const isRenaming =
          !!renamingEntry && normalizePath(renamingEntry.path) === normalizePath(entry.path);
        const relativePath = currentProject ? buildRelativePath(currentProject.path, entry.path) : entry.path;
        const displayName = searchMode ? highlightText(entry.name, filterValue) : entry.name;
        const visual = getFileIcon(entry.name, isDirectory, isExpanded);

        const handleMenuClick: NonNullable<MenuProps["onClick"]> = async ({ key, domEvent }) => {
          domEvent.preventDefault();
          domEvent.stopPropagation();
          if (!(isSelected && selectionCount > 1)) {
            selectOnlyPath(entry.path);
          }

          if (key === "create-file") {
            void handleCreateResource("file", getCreateTargetDirectory(projectRootPath, entry));
            return;
          }

          if (key === "create-folder") {
            void handleCreateResource("directory", getCreateTargetDirectory(projectRootPath, entry));
            return;
          }

          if (key === "copy") {
            handleCopyEntries([entry]);
            return;
          }

          if (key === "paste") {
            void handlePasteEntries(getCreateTargetDirectory(projectRootPath, entry));
            return;
          }

          if (key === "open-in-associated-app") {
            onOpenInAssociatedApp(entry.path);
            return;
          }

          if (key === "open-in-manager") {
            onOpenInFileManager(entry.path);
            return;
          }

          if (key === "find-in-directory" && isDirectory) {
            openGlobalTextSearch(entry.path);
            return;
          }

          if (key === "copy-relative-path") {
            await navigator.clipboard.writeText(relativePath);
            message.success(copyPathSuccessText);
            return;
          }

          if (key === "copy-absolute-path") {
            await navigator.clipboard.writeText(entry.path);
            message.success(copyPathSuccessText);
            return;
          }

          if (key === "rename") {
            handleOpenRename(entry);
            return;
          }

          if (key === "delete") {
            handleRequestDeleteEntries([entry]);
          }
        };

        const menuItems: MenuProps["items"] = [
          {
            key: "create-file",
            icon: <FileOutlined />,
            label: t("sidebar.createFile"),
          },
          {
            key: "create-folder",
            icon: <FolderOutlined />,
            label: t("sidebar.createFolder"),
          },
          { type: "divider" },
          ...(isDirectory
            ? []
            : [
              {
                key: "open-in-associated-app",
                icon: <ExportOutlined />,
                label: openInAssociatedAppText,
              },
            ]),
          ...(isDirectory
            ? [
              {
                key: "find-in-directory",
                icon: <SearchOutlined />,
                label: t("globalSearch.findInDirectory"),
              },
            ]
            : []),
          {
            key: "open-in-manager",
            icon: <FolderOpenFilled />,
            label: openInManagerText,
          },
          {
            key: "copy-relative-path",
            icon: <CopyOutlined />,
            label: copyRelativePathText,
          },
          {
            key: "copy",
            icon: <CopyOutlined />,
            label: t("common.copy"),
          },
          ...(isDirectory
            ? [
              {
                key: "paste",
                icon: <SnippetsOutlined />,
                label: t("common.paste"),
                disabled: !hasClipboardEntries || pasteSubmitting,
              },
            ]
            : []),
          {
            key: "copy-absolute-path",
            icon: <CopyOutlined />,
            label: copyAbsolutePathText,
          },
          { type: "divider" },
          {
            key: "rename",
            icon: <EditOutlined />,
            label: t("common.rename"),
          },
          {
            key: "delete",
            icon: <DeleteOutlined />,
            label: t("common.delete"),
            danger: true,
          },
        ];

        return (
          <div key={entry.path}>
            {isRenaming ? (
              <div
                className="app-file-tree-row w-full text-left"
                data-active={isActive ? "true" : "false"}
                data-selected={isSelected ? "true" : "false"}
                data-path={entry.path}
                data-drag-over={isDirectory && dragOverPath === entry.path ? "true" : "false"}
                style={{ paddingLeft: 8 + depth * 16 }}
                onClick={(event) => event.stopPropagation()}
              >
                <span className="app-file-tree-arrow">
                  {isDirectory ? (isExpanded ? <DownOutlined /> : <RightOutlined />) : null}
                </span>
                <span
                  className="app-file-tree-icon"
                  style={{ color: visual.color }}
                >
                  {visual.icon}
                </span>
                <Input
                  ref={renameInputRef}
                  size="small"
                  value={renameValue}
                  status={renameSubmitting ? undefined : undefined}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onPressEnter={() => void handleConfirmRename()}
                  onBlur={() => {
                    void handleConfirmRename();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      handleCancelRename();
                    }
                  }}
                  disabled={renameSubmitting}
                  className="min-w-0"
                />
              </div>
            ) : (
              <Dropdown menu={{ items: menuItems, onClick: handleMenuClick }} trigger={["contextMenu"]}>
                <button
                  type="button"
                  className="app-file-tree-row w-full text-left"
                  data-active={isActive ? "true" : "false"}
                  data-selected={isSelected ? "true" : "false"}
                  data-path={entry.path}
                  data-drag-over={isDirectory && dragOverPath === entry.path ? "true" : "false"}
                  style={{ paddingLeft: 8 + depth * 16 }}
                  onContextMenu={(event) => {
                    event.stopPropagation();
                    if (!(isSelected && selectionCount > 1)) {
                      selectOnlyPath(entry.path);
                    }
                  }}
                  onPointerDown={(event) => handleStartResourceDrag(event, entry)}
                  onClick={() => {
                    if (suppressNextClickPathRef.current === entry.path) {
                      suppressNextClickPathRef.current = null;
                      return;
                    }
                    selectOnlyPath(entry.path);
                    if (isDirectory) {
                      if (searchMode) {
                        return;
                      }
                      void handleToggleDirectory(entry);
                      return;
                    }
                    onOpenFile(entry.path);
                  }}
                  onDoubleClick={() => {
                    if (!isDirectory) {
                      onOpenFile(entry.path, { preview: false });
                    }
                  }}
                >
                  <span className="app-file-tree-arrow">
                    {isDirectory ? (isExpanded ? <DownOutlined /> : <RightOutlined />) : null}
                  </span>
                  <span
                    className="app-file-tree-icon"
                    style={{ color: visual.color }}
                  >
                    {visual.icon}
                  </span>
                  <span className="truncate">{displayName}</span>
                </button>
              </Dropdown>
            )}

            {isDirectory && isExpanded && (
              <div>
                {isLoadingChildren ? (
                  <div
                    className="flex items-center gap-2 py-1 text-[11px]"
                    style={{ paddingLeft: 28 + depth * 16, color: "var(--cs-text-tertiary)" }}
                  >
                    <Spin size="small" />
                    <span>{loadingText}</span>
                  </div>
                ) : children.length > 0 ? (
                  renderNodes(children, depth + 1, searchMode)
                ) : !searchMode ? (
                  <div
                    className="py-1 text-[11px]"
                    style={{ paddingLeft: 28 + depth * 16, color: "var(--cs-text-tertiary)" }}
                  >
                    {emptyFolderText}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        );
      }),
    [
      copyAbsolutePathText,
      openInAssociatedAppText,
      copyPathSuccessText,
      copyRelativePathText,
      currentProject,
      emptyFolderText,
      filterValue,
      handleCancelRename,
      actionableSelectedEntries.length,
      handleCopyEntries,
      handlePasteEntries,
      handleRequestDeleteEntries,
      handleCreateResource,
      handleConfirmRename,
      handleStartResourceDrag,
      handleOpenRename,
      handleToggleDirectory,
      hasClipboardEntries,
      loadingText,
      normalizedSelectedPaths,
      onOpenInAssociatedApp,
      onOpenInFileManager,
      openInManagerText,
      onOpenFile,
      pasteSubmitting,
      projectRootPath,
      selectedPath,
      selectOnlyPath,
      dragOverPath,
      t,
    ]
  );

  const handleTreeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const hasPrimaryModifier = event.ctrlKey || event.metaKey;
      const lowerKey = event.key.toLowerCase();

      if (hasPrimaryModifier && !event.shiftKey && !event.altKey && lowerKey === "c") {
        if (!canCopySelection) return;
        event.preventDefault();
        event.stopPropagation();
        handleCopyEntries(actionableSelectedEntries);
        return;
      }

      if (hasPrimaryModifier && !event.shiftKey && !event.altKey && lowerKey === "v") {
        if (!canPasteEntries) return;
        event.preventDefault();
        event.stopPropagation();
        void handlePasteEntries(backgroundCreateTargetPath);
        return;
      }

      if (!hasPrimaryModifier && !event.shiftKey && !event.altKey && (event.key === "Delete" || event.key === "Backspace")) {
        if (!canDeleteSelection) return;
        event.preventDefault();
        event.stopPropagation();
        handleRequestDeleteEntries(actionableSelectedEntries);
        return;
      }

      if (event.key === "Escape" && selectedPaths.length > 1) {
        event.preventDefault();
        event.stopPropagation();
        selectOnlyPath(selectedPath ?? backgroundCreateTargetPath);
      }
    },
    [
      actionableSelectedEntries,
      backgroundCreateTargetPath,
      canCopySelection,
      canDeleteSelection,
      canPasteEntries,
      handleCopyEntries,
      handlePasteEntries,
      handleRequestDeleteEntries,
      selectOnlyPath,
      selectedPath,
      selectedPaths.length,
    ]
  );

  if (!currentProject) {
    return <Empty description={noProjectText} className="mt-16" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  return (
    <div className="app-sidebar-panel flex h-full min-h-0 flex-col">
      <div
        className="flex items-center justify-between px-2 pb-2 pt-1"
        style={{ borderBottom: "1px solid var(--cs-border-sidebar)" }}
      >
        <div className="text-sm font-semibold" style={{ color: "var(--cs-text-primary)" }}>
          {panelTitle}
        </div>
        <div className="flex items-center gap-1">
          <Tooltip title={refreshText} mouseEnterDelay={0.4}>
            <button
              type="button"
              className="app-file-toolbar-button"
              onClick={handleRefresh}
              aria-label={refreshText}
            >
              <ReloadOutlined />
            </button>
          </Tooltip>
          <Tooltip title={t("sidebar.collapseAll")} mouseEnterDelay={0.4}>
            <button
              type="button"
              className="app-file-toolbar-button"
              onClick={handleCollapseAll}
              aria-label={t("sidebar.collapseAll")}
            >
              <CompressOutlined />
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="flex flex-1 min-h-0 flex-col px-1 py-2">
        <div className="px-2 pb-2">
          <div className="app-file-breadcrumbs">
            {breadcrumbs.map((segment, index) => {
              const isLast = index === breadcrumbs.length - 1;
              return (
                <div key={segment.path} className="flex min-w-0 items-center gap-1">
                  {index > 0 && <span className="app-file-breadcrumb-separator">/</span>}
                  <button
                    type="button"
                    className="app-file-breadcrumb-button"
                    data-active={isLast ? "true" : "false"}
                    onClick={() => {
                      if (isLast) {
                        selectOnlyPath(segment.path);
                        return;
                      }
                      void revealPath(segment.path, true);
                    }}
                  >
                    {segment.label}
                  </button>
                </div>
              );
            })}
          </div>
          <Input
            size="small"
            allowClear
            value={filterValue}
            onChange={(event) => setFilterValue(event.target.value)}
            placeholder={filterPlaceholderText}
            prefix={<SearchOutlined className="text-[11px]" />}
            className="mt-2"
          />
        </div>

        <Dropdown menu={{ items: backgroundMenuItems, onClick: handleBackgroundMenuClick }} trigger={["contextMenu"]}>
          <div
            ref={treeContainerRef}
            className="app-project-tree-scroll mt-1 flex-1 min-h-0 overflow-y-auto"
            data-explorer-shortcuts="true"
            data-drag-over={isExternalDragOver && !dragOverPath ? "true" : "false"}
            tabIndex={0}
            onMouseDown={(event) => {
              const target = event.target as HTMLElement | null;
              if (!target?.closest(".app-file-tree-row")) {
                treeContainerRef.current?.focus();
              }
            }}
            onContextMenu={(event) => {
              const target = event.target as HTMLElement | null;
              if (target?.closest(".app-file-tree-row")) {
                return;
              }
              selectOnlyPath(backgroundCreateTargetPath);
            }}
            onKeyDown={handleTreeKeyDown}
          >
            {error ? (
              <div className="px-2 py-3 text-[11px]" style={{ color: "#ff7875" }}>
                {error}
              </div>
            ) : loadingRoot ? (
              <div className="flex items-center gap-2 px-2 py-3 text-[11px]" style={{ color: "var(--cs-text-tertiary)" }}>
                <Spin size="small" />
                <span>{loadingText}</span>
              </div>
            ) : searchLoading ? (
              <div className="flex items-center gap-2 px-2 py-3 text-[11px]" style={{ color: "var(--cs-text-tertiary)" }}>
                <Spin size="small" />
                <span>{loadingText}</span>
              </div>
            ) : isSearchMode ? (
              searchTree.length > 0 ? (
                <div>{renderNodes(searchTree, 0, true)}</div>
              ) : (
                <div className="px-2 py-3 text-[11px]" style={{ color: "var(--cs-text-tertiary)" }}>
                  {filterNoResultsText}
                </div>
              )
            ) : visibleTree.length > 0 ? (
              <div>{renderNodes(visibleTree)}</div>
            ) : (
              <div className="px-2 py-3 text-[11px]" style={{ color: "var(--cs-text-tertiary)" }}>
                {emptyFolderText}
              </div>
            )}
          </div>
        </Dropdown>
      </div>

      <Modal
        title={
          pendingExternalCopy
            ? pendingExternalCopy.sourcePaths.length === 1
              ? t("sidebar.externalCopyTitleSingle", {
                  defaultValue: "复制文件 {{name}}",
                  name: getBaseName(pendingExternalCopy.sourcePaths[0] ?? ""),
                })
              : t("sidebar.externalCopyTitleMultiple", {
                  defaultValue: "复制 {{count}} 个项目",
                  count: pendingExternalCopy.sourcePaths.length,
                })
            : t("common.copy")
        }
        open={!!pendingExternalCopy}
        okText={t("common.confirm")}
        cancelText={t("common.cancel")}
        confirmLoading={externalCopySubmitting}
        okButtonProps={{
          disabled:
            externalCopySubmitting ||
            externalCopyValidation.hasBlankName ||
            externalCopyValidation.hasInvalidName ||
            externalCopyValidation.conflictNames.length > 0 ||
            !pendingExternalCopy?.destinationDirectory.trim(),
        }}
        onOk={() => void handleConfirmExternalCopy()}
        onCancel={() => {
          if (externalCopySubmitting) return;
          setPendingExternalCopy(null);
        }}
        destroyOnClose
        width={680}
      >
        {pendingExternalCopy ? (
          <div className="space-y-4 pt-1">
            <div className="rounded-[8px] px-3 py-2 text-[12px]"
              style={{
                background: "color-mix(in srgb, var(--cs-bg-hover) 78%, transparent)",
                color: "var(--cs-text-secondary)",
              }}
            >
              {pendingExternalCopy.sourcePaths.length === 1 ? (
                <span className="break-all">{pendingExternalCopy.sourcePaths[0]}</span>
              ) : (
                <span>
                  {t("sidebar.externalCopySourceSummary", {
                    defaultValue: "已选择 {{count}} 个外部项目",
                    count: pendingExternalCopy.sourcePaths.length,
                  })}
                </span>
              )}
            </div>

            <label className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-3 text-[13px]">
              <span style={{ color: "var(--cs-text-secondary)" }}>
                {t("sidebar.externalCopyNewName", { defaultValue: "新名称" })}
              </span>
              <Input
                value={pendingExternalCopy.newName}
                disabled={pendingExternalCopy.sourcePaths.length !== 1 || externalCopySubmitting}
                status={
                  externalCopyValidation.hasInvalidName ||
                  externalCopyValidation.conflictNames.length > 0
                    ? "error"
                    : undefined
                }
                onChange={(event) =>
                  setPendingExternalCopy((current) =>
                    current ? { ...current, newName: event.target.value } : current
                  )
                }
              />
            </label>
            {externalCopyValidation.hasInvalidName ? (
              <div className="grid grid-cols-[88px_minmax(0,1fr)] items-start gap-3 text-[12px]">
                <span />
                <div
                  className="rounded-[6px] px-3 py-2"
                  style={{
                    background: "color-mix(in srgb, var(--cs-error) 12%, transparent)",
                    color: "color-mix(in srgb, var(--cs-error) 88%, var(--cs-text-primary) 12%)",
                  }}
                >
                  {t("sidebar.externalCopyInvalidName", {
                    defaultValue: "名称不能包含路径分隔符，也不能是 . 或 ..",
                  })}
                </div>
              </div>
            ) : null}
            {externalCopyValidation.conflictNames.length > 0 ? (
              <div className="grid grid-cols-[88px_minmax(0,1fr)] items-start gap-3 text-[12px]">
                <span />
                <div
                  className="rounded-[6px] px-3 py-2"
                  style={{
                    background: "color-mix(in srgb, var(--cs-error) 12%, transparent)",
                    color: "color-mix(in srgb, var(--cs-error) 88%, var(--cs-text-primary) 12%)",
                  }}
                >
                  {pendingExternalCopy.sourcePaths.length === 1
                    ? t("sidebar.externalCopyNameExists", {
                        defaultValue: "目标目录已存在同名文件，请修改新名称后再确认",
                      })
                    : t("sidebar.externalCopyNamesExist", {
                        defaultValue: "目标目录已存在同名项目：{{names}}",
                        names: externalCopyValidation.conflictNames.join(", "),
                      })}
                </div>
              </div>
            ) : null}

            <label className="grid grid-cols-[88px_minmax(0,1fr)] items-start gap-3 text-[13px]">
              <span className="pt-1.5" style={{ color: "var(--cs-text-secondary)" }}>
                {t("sidebar.externalCopyDestination", { defaultValue: "到目录" })}
              </span>
              <div className="min-w-0">
                <div className="flex min-w-0 gap-2">
                  <Input
                    value={pendingExternalCopy.destinationDirectory}
                    disabled={externalCopySubmitting}
                    onChange={(event) =>
                      setPendingExternalCopy((current) =>
                        current ? { ...current, destinationDirectory: event.target.value } : current
                      )
                    }
                  />
                  <Button
                    icon={<FolderOpenFilled />}
                    disabled={externalCopySubmitting}
                    onClick={() => void handleChooseExternalCopyDirectory()}
                  />
                </div>
                <div className="mt-1 text-[11px]" style={{ color: "var(--cs-text-tertiary)" }}>
                  {t("sidebar.externalCopyPathHint", {
                    defaultValue: "可直接输入任意存在的目录，也可以选择一个目录",
                  })}
                </div>
              </div>
            </label>

            <Checkbox
              checked={
                pendingExternalCopy.openAfterCopy &&
                isPathInsideRoot(projectRootPath, pendingExternalCopy.destinationDirectory)
              }
              disabled={
                pendingExternalCopy.sourcePaths.length !== 1 ||
                !isProbablyFilePath(pendingExternalCopy.newName) ||
                !isPathInsideRoot(projectRootPath, pendingExternalCopy.destinationDirectory) ||
                externalCopySubmitting
              }
              onChange={(event) =>
                setPendingExternalCopy((current) =>
                  current ? { ...current, openAfterCopy: event.target.checked } : current
                )
              }
            >
              {t("sidebar.externalCopyOpenAfterCopy", { defaultValue: "复制后在编辑器中打开" })}
            </Checkbox>
          </div>
        ) : null}
      </Modal>

      <Modal
        title={t("sidebar.resourceDeleteTitle")}
        open={deletingEntries.length > 0}
        okText={t("common.delete")}
        cancelText={t("common.cancel")}
        okButtonProps={{ danger: true }}
        onOk={() => void handleConfirmDelete()}
        confirmLoading={deleteSubmitting}
        onCancel={() => {
          if (deleteSubmitting) return;
          setDeletingEntries([]);
        }}
        destroyOnClose
      >
        {deletingEntries.length > 1
          ? t("sidebar.resourceDeleteConfirmMultiple", { count: deletingEntries.length })
          : deletingEntries[0]
            ? t("sidebar.resourceDeleteConfirm", { name: deletingEntries[0].name })
            : null}
      </Modal>
    </div>
  );
}

export default SidebarProjectPanel;
