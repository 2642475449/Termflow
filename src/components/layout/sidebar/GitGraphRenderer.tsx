/**
 * Git Graph Renderer - 对齐 VS Code SCM History 的泳道模型与节点几何
 * 参考: vscode-main/src/vs/workbench/contrib/scm/browser/scmHistory.ts
 *
 * 使用虚拟滚动优化：只渲染可见区域的提交记录，大幅减少DOM节点数量
 */

import { useMemo, useState, useRef, useCallback, useEffect } from "react";
import { Dropdown } from "antd";
import type { MenuProps } from "antd";
import type {
  GitGraphChangedFile,
  GitGraphCommit,
  GitGraphRef,
} from "@/types";
import {
  GIT_GRAPH_FILE_ROW_HEIGHT,
  getGitGraphExpansionRowCount,
  GitGraphChangedFiles,
} from "./GitGraphChangedFiles";
import { splitWorktreeReferences } from "./gitGraphReferences";

const SWIMLANE_HEIGHT = 22;
const SWIMLANE_WIDTH = 11;
const ROW_HORIZONTAL_INSET = 4;
const SWIMLANE_CURVE_RADIUS = 5;
const CIRCLE_RADIUS = 4;
const CIRCLE_STROKE_WIDTH = 2;

const HISTORY_ITEM_REF_COLOR = "#59a4f9";
const HISTORY_ITEM_REMOTE_REF_COLOR = "#B180D7";
const HISTORY_ITEM_BASE_REF_COLOR = "#EA5C00";

const COLOR_REGISTRY = [
  "#FFB000",
  "#DC267F",
  "#994F00",
  "#40B0A6",
  "#B66DFF",
];

interface GraphNode {
  id: string;
  color: string;
}

interface GraphRowLayout {
  kind: "HEAD" | "node";
  inputSwimlanes: GraphNode[];
  outputSwimlanes: GraphNode[];
}

interface ReferenceBadge {
  key: string;
  name: string;
  color?: string;
  worktreeCount?: number;
  worktreeNames?: string[];
}

function rot(index: number, modulo: number): number {
  return ((index % modulo) + modulo) % modulo;
}

function cloneNode(node: GraphNode): GraphNode {
  return { ...node };
}

function getRefColor(ref: GitGraphRef, branchColorMap: Map<string, string>): string | undefined {
  switch (ref.kind) {
    case "head":
      return HISTORY_ITEM_REF_COLOR;
    case "remote":
      return HISTORY_ITEM_REMOTE_REF_COLOR;
    case "tag":
      return HISTORY_ITEM_BASE_REF_COLOR;
    case "branch":
    case "ref":
      return branchColorMap.get(ref.name);
    default:
      return undefined;
  }
}

function getCommitLabelColor(commit: GitGraphCommit | undefined, branchColorMap: Map<string, string>): string | undefined {
  if (!commit) {
    return undefined;
  }

  for (const ref of commit.refs) {
    const color = getRefColor(ref, branchColorMap);
    if (color) {
      return color;
    }
  }

  return undefined;
}

function getReferenceBadges(
  commit: GitGraphCommit,
  branchColorMap: Map<string, string>,
  fallbackColor: string
): ReferenceBadge[] {
  const { regular, worktrees } = splitWorktreeReferences(commit.refs);
  const badges: ReferenceBadge[] = [...regular]
    .sort((a, b) => {
      const rank = (kind: string) => {
        switch (kind) {
          case "head":
            return 0;
          case "branch":
            return 1;
          case "remote":
            return 2;
          case "tag":
            return 3;
          default:
            return 4;
        }
      };

      return rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name);
    })
    .map((ref) => ({
      key: `${ref.kind}:${ref.name}`,
      name: ref.name,
      color: getRefColor(ref, branchColorMap) ?? fallbackColor,
    }));

  if (worktrees.length > 0) {
    badges.push({
      key: "worktrees",
      name: `worktrees ${worktrees.length}`,
      worktreeCount: worktrees.length,
      worktreeNames: worktrees.map((ref) => ref.name),
    });
  }

  return badges;
}

function findLastIndex(nodes: GraphNode[], id: string): number {
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    if (nodes[i].id === id) {
      return i;
    }
  }

  return -1;
}

function buildBranchColorMap(commits: GitGraphCommit[]): Map<string, string> {
  const colorMap = new Map<string, string>();
  let colorIndex = -1;

  for (const commit of commits) {
    for (const ref of commit.refs) {
      if ((ref.kind !== "branch" && ref.kind !== "ref") || colorMap.has(ref.name)) {
        continue;
      }

      colorIndex = rot(colorIndex + 1, COLOR_REGISTRY.length);
      colorMap.set(ref.name, COLOR_REGISTRY[colorIndex]);
    }
  }

  return colorMap;
}

function computeGraphRows(commits: GitGraphCommit[]): {
  rows: GraphRowLayout[];
  branchColorMap: Map<string, string>;
} {
  const rows: GraphRowLayout[] = [];
  const commitsByOid = new Map(commits.map((commit) => [commit.oid, commit]));
  const branchColorMap = buildBranchColorMap(commits);
  let colorIndex = -1;

  for (const commit of commits) {
    const previousRow = rows.length > 0 ? rows[rows.length - 1] : undefined;
    const inputSwimlanes = previousRow?.outputSwimlanes.map(cloneNode) ?? [];
    const outputSwimlanes: GraphNode[] = [];
    let firstParentAdded = false;

    if (commit.parentOids.length > 0) {
      for (const node of inputSwimlanes) {
        if (node.id === commit.oid) {
          if (!firstParentAdded) {
            outputSwimlanes.push({
              id: commit.parentOids[0],
              color: getCommitLabelColor(commit, branchColorMap) ?? node.color,
            });
            firstParentAdded = true;
          }

          continue;
        }

        outputSwimlanes.push(cloneNode(node));
      }
    }

    for (let i = firstParentAdded ? 1 : 0; i < commit.parentOids.length; i += 1) {
      let color =
        i === 0
          ? getCommitLabelColor(commit, branchColorMap)
          : getCommitLabelColor(commitsByOid.get(commit.parentOids[i]), branchColorMap);

      if (!color) {
        colorIndex = rot(colorIndex + 1, COLOR_REGISTRY.length);
        color = COLOR_REGISTRY[colorIndex];
      }

      outputSwimlanes.push({
        id: commit.parentOids[i],
        color,
      });
    }

    rows.push({
      kind: commit.refs.some((ref) => ref.kind === "head") ? "HEAD" : "node",
      inputSwimlanes,
      outputSwimlanes,
    });
  }

  return { rows, branchColorMap };
}

interface GitGraphRendererProps {
  commits: GitGraphCommit[];
  selectedCommitOid?: string | null;
  expandedCommitOid?: string | null;
  expandedFiles?: GitGraphChangedFile[];
  expandedFilesLoading?: boolean;
  expandedFilesError?: boolean;
  selectedFileKey?: string | null;
  openingFileKey?: string | null;
  onCommitSelect?: (commit: GitGraphCommit) => void;
  onFileSelect?: (
    commit: GitGraphCommit,
    file: GitGraphChangedFile,
  ) => void;
  buildCommitMenu?: (commit: GitGraphCommit) => MenuProps;
  onCommitHover?: (commit: GitGraphCommit, rect: DOMRect) => void;
  onCommitLeave?: () => void;
}
export function GitGraphRenderer({
  commits,
  selectedCommitOid,
  expandedCommitOid,
  expandedFiles = [],
  expandedFilesLoading = false,
  expandedFilesError = false,
  selectedFileKey = null,
  openingFileKey = null,
  onCommitSelect,
  onFileSelect,
  buildCommitMenu,
  onCommitHover,
  onCommitLeave,
}: GitGraphRendererProps) {
  const { rows, branchColorMap } = useMemo(() => computeGraphRows(commits), [commits]);
  const [hoveredCommitOid, setHoveredCommitOid] = useState<string | null>(null);
  const expandedCommitIndex = expandedCommitOid
    ? commits.findIndex((commit) => commit.oid === expandedCommitOid)
    : -1;
  const expansionRowCount = expandedCommitIndex >= 0
    ? getGitGraphExpansionRowCount(
        expandedFiles,
        expandedFilesLoading,
        expandedFilesError,
      )
    : 0;
  const expansionHeight = expansionRowCount * GIT_GRAPH_FILE_ROW_HEIGHT;

  // 虚拟滚动相关
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);

  // 计算可见区域
  const { visibleStart, visibleEnd, totalHeight, offsetY } = useMemo(() => {
    const bufferHeight = SWIMLANE_HEIGHT * 5;
    const rowOffsets: number[] = [];
    const rowHeights: number[] = [];
    let nextOffset = 0;

    for (let index = 0; index < commits.length; index += 1) {
      rowOffsets.push(nextOffset);
      const rowHeight = SWIMLANE_HEIGHT
        + (index === expandedCommitIndex ? expansionHeight : 0);
      rowHeights.push(rowHeight);
      nextOffset += rowHeight;
    }

    const viewportStart = Math.max(0, scrollTop - bufferHeight);
    const viewportEnd = scrollTop + containerHeight + bufferHeight;
    let start = 0;
    while (
      start < commits.length
      && rowOffsets[start] + rowHeights[start] < viewportStart
    ) {
      start += 1;
    }

    let end = start;
    while (end < commits.length && rowOffsets[end] < viewportEnd) {
      end += 1;
    }
    if (end === start && start < commits.length) {
      end += 1;
    }

    return {
      visibleStart: start,
      visibleEnd: end,
      totalHeight: nextOffset,
      offsetY: rowOffsets[start] ?? 0,
    };
  }, [
    commits,
    containerHeight,
    expandedCommitIndex,
    expansionHeight,
    scrollTop,
  ]);
  const handleScroll = useCallback(() => {
    if (containerRef.current) {
      setScrollTop(containerRef.current.scrollTop);
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // 初始获取容器高度
    setContainerHeight(container.clientHeight);

    // 监听滚动
    container.addEventListener("scroll", handleScroll, { passive: true });

    // 监听容器尺寸变化
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setContainerHeight(entry.contentRect.height);
      }
    });
    resizeObserver.observe(container);

    return () => {
      container.removeEventListener("scroll", handleScroll);
      resizeObserver.disconnect();
    };
  }, [handleScroll]);

  // 只渲染可见区域的提交
  const visibleCommits = commits.slice(visibleStart, visibleEnd);

  return (
    <div
      ref={containerRef}
      className="flex flex-col flex-1 min-h-0 overflow-y-auto app-project-tree-scroll px-1"
      style={{ position: "relative" }}
    >
      {/* 占位元素，撑开滚动高度 */}
      <div style={{ height: totalHeight, position: "relative" }}>
        {/* 可见区域容器 */}
        <div style={{ position: "absolute", top: offsetY, left: 0, right: 0 }}>
          {visibleCommits.map((commit, localIdx) => {
            const idx = visibleStart + localIdx;
            const row = rows[idx];
            const inputSwimlanes = row.inputSwimlanes;
            const outputSwimlanes = row.outputSwimlanes;
            const isHead = row.kind === "HEAD";
            const isMerge = commit.parentOids.length > 1;
            const isHovered = hoveredCommitOid === commit.oid;
            const isSelected = selectedCommitOid === commit.oid;
            const isExpanded = expandedCommitOid === commit.oid;
        const baseBackdrop = "var(--cs-bg-card-solid, var(--cs-bg-sidebar))";
        const selectedBackground = "color-mix(in srgb, var(--cs-primary) 12%, var(--cs-bg-card-solid, var(--cs-bg-sidebar)) 88%)";
        const rowBackground = isSelected
          ? selectedBackground
          : isHovered
            ? "var(--cs-bg-hover)"
            : "transparent";
        const nodeInnerBackdrop = isSelected
          ? selectedBackground
          : isHovered
            ? "var(--cs-bg-hover)"
            : baseBackdrop;
        const outerNodeStroke = isSelected || isHovered ? "transparent" : baseBackdrop;
        const regularNodeStroke = isSelected ? selectedBackground : isHovered ? "var(--cs-bg-hover)" : baseBackdrop;

        const svgElements: React.ReactNode[] = [];
        const inputIndex = inputSwimlanes.findIndex((node) => node.id === commit.oid);
        const circleIndex = inputIndex !== -1 ? inputIndex : inputSwimlanes.length;
        const rowColumnCount = Math.max(
          1,
          inputSwimlanes.length,
          outputSwimlanes.length,
          circleIndex + 1
        );
        const rowGraphWidth = SWIMLANE_WIDTH * (rowColumnCount + 1);
        const circleColor =
          outputSwimlanes[circleIndex]?.color ??
          inputSwimlanes[circleIndex]?.color ??
          HISTORY_ITEM_REF_COLOR;
        const referenceBadges = getReferenceBadges(commit, branchColorMap, circleColor);

        let outputSwimlaneIndex = 0;

        for (let index = 0; index < inputSwimlanes.length; index += 1) {
          const color = inputSwimlanes[index].color;

          if (inputSwimlanes[index].id === commit.oid) {
            if (index !== circleIndex) {
              const d: string[] = [];
              d.push(`M ${SWIMLANE_WIDTH * (index + 1)} 0`);
              d.push(`A ${SWIMLANE_WIDTH} ${SWIMLANE_WIDTH} 0 0 1 ${SWIMLANE_WIDTH * index} ${SWIMLANE_WIDTH}`);
              d.push(`H ${SWIMLANE_WIDTH * (circleIndex + 1)}`);

              svgElements.push(
                <path
                  key={`base-${index}`}
                  d={d.join(" ")}
                  fill="none"
                  stroke={color}
                  strokeWidth={1}
                  strokeLinecap="round"
                />
              );
            } else {
              outputSwimlaneIndex += 1;
            }
          } else if (
            outputSwimlaneIndex < outputSwimlanes.length &&
            inputSwimlanes[index].id === outputSwimlanes[outputSwimlaneIndex].id
          ) {
            if (index === outputSwimlaneIndex) {
              svgElements.push(
                <path
                  key={`line-${index}`}
                  d={`M ${SWIMLANE_WIDTH * (index + 1)} 0 V ${SWIMLANE_HEIGHT}`}
                  fill="none"
                  stroke={color}
                  strokeWidth={1}
                  strokeLinecap="round"
                />
              );
            } else {
              const d: string[] = [];
              d.push(`M ${SWIMLANE_WIDTH * (index + 1)} 0`);
              d.push("V 6");
              d.push(
                `A ${SWIMLANE_CURVE_RADIUS} ${SWIMLANE_CURVE_RADIUS} 0 0 1 ${
                  SWIMLANE_WIDTH * (index + 1) - SWIMLANE_CURVE_RADIUS
                } ${SWIMLANE_HEIGHT / 2}`
              );
              d.push(`H ${SWIMLANE_WIDTH * (outputSwimlaneIndex + 1) + SWIMLANE_CURVE_RADIUS}`);
              d.push(
                `A ${SWIMLANE_CURVE_RADIUS} ${SWIMLANE_CURVE_RADIUS} 0 0 0 ${
                  SWIMLANE_WIDTH * (outputSwimlaneIndex + 1)
                } ${(SWIMLANE_HEIGHT / 2) + SWIMLANE_CURVE_RADIUS}`
              );
              d.push(`V ${SWIMLANE_HEIGHT}`);

              svgElements.push(
                <path
                  key={`curve-${index}`}
                  d={d.join(" ")}
                  fill="none"
                  stroke={color}
                  strokeWidth={1}
                  strokeLinecap="round"
                />
              );
            }

            outputSwimlaneIndex += 1;
          }
        }

        for (let i = 1; i < commit.parentOids.length; i += 1) {
          const parentOutputIndex = findLastIndex(outputSwimlanes, commit.parentOids[i]);
          if (parentOutputIndex === -1) {
            continue;
          }

          const d: string[] = [];
          const color = outputSwimlanes[parentOutputIndex].color;
          d.push(`M ${SWIMLANE_WIDTH * parentOutputIndex} ${SWIMLANE_HEIGHT / 2}`);
          d.push(`A ${SWIMLANE_WIDTH} ${SWIMLANE_WIDTH} 0 0 1 ${SWIMLANE_WIDTH * (parentOutputIndex + 1)} ${SWIMLANE_HEIGHT}`);
          d.push(`M ${SWIMLANE_WIDTH * parentOutputIndex} ${SWIMLANE_HEIGHT / 2}`);
          d.push(`H ${SWIMLANE_WIDTH * (circleIndex + 1)}`);

          svgElements.push(
            <path
              key={`parent-${i}`}
              d={d.join(" ")}
              fill="none"
              stroke={color}
              strokeWidth={1}
              strokeLinecap="round"
            />
          );
        }

        if (inputIndex !== -1) {
          svgElements.push(
            <path
              key={`up-${circleIndex}`}
              d={`M ${SWIMLANE_WIDTH * (circleIndex + 1)} 0 V ${SWIMLANE_HEIGHT / 2}`}
              fill="none"
              stroke={inputSwimlanes[inputIndex].color}
              strokeWidth={1}
              strokeLinecap="round"
            />
          );
        }

        if (commit.parentOids.length > 0) {
          svgElements.push(
            <path
              key={`down-${circleIndex}`}
              d={`M ${SWIMLANE_WIDTH * (circleIndex + 1)} ${SWIMLANE_HEIGHT / 2} V ${SWIMLANE_HEIGHT}`}
              fill="none"
              stroke={circleColor}
              strokeWidth={1}
              strokeLinecap="round"
            />
          );
        }

        const cx = SWIMLANE_WIDTH * (circleIndex + 1);
        const cy = SWIMLANE_WIDTH;

        if (isHead) {
          svgElements.push(
            <circle
              key="outer"
              cx={cx}
              cy={cy}
              r={CIRCLE_RADIUS + 3}
              fill={circleColor}
              stroke={outerNodeStroke}
              strokeWidth={CIRCLE_STROKE_WIDTH}
            />,
            <circle
              key="inner"
              cx={cx}
              cy={cy}
              r={CIRCLE_STROKE_WIDTH}
              fill={nodeInnerBackdrop}
              stroke={nodeInnerBackdrop}
              strokeWidth={CIRCLE_RADIUS}
            />
          );
        } else if (isMerge) {
          svgElements.push(
            <circle
              key="outer"
              cx={cx}
              cy={cy}
              r={CIRCLE_RADIUS + 2}
              fill={circleColor}
              stroke={outerNodeStroke}
              strokeWidth={CIRCLE_STROKE_WIDTH}
            />,
            <circle
              key="inner"
              cx={cx}
              cy={cy}
              r={CIRCLE_RADIUS - 1}
              fill={circleColor}
              stroke={nodeInnerBackdrop}
              strokeWidth={CIRCLE_STROKE_WIDTH}
            />
          );
        } else {
          svgElements.push(
            <circle
              key="node"
              cx={cx}
              cy={cy}
              r={CIRCLE_RADIUS + 1}
              fill={circleColor}
              stroke={regularNodeStroke}
              strokeWidth={CIRCLE_STROKE_WIDTH}
            />
          );
        }

        return (
          <div key={commit.oid}>
            <Dropdown
              trigger={["contextMenu"]}
              menu={buildCommitMenu?.(commit)}
              disabled={!buildCommitMenu}
            >
              <div
                className="group flex items-center gap-0 cursor-pointer"
                style={{
                  height: SWIMLANE_HEIGHT,
                  flexShrink: 0,
                  background: rowBackground,
                  paddingInline: ROW_HORIZONTAL_INSET,
                }}
                onClick={() => onCommitSelect?.(commit)}
                onMouseEnter={(e) => {
                  setHoveredCommitOid(commit.oid);
                  if (onCommitHover) {
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    onCommitHover(commit, rect);
                  }
                }}
                onMouseLeave={() => {
                  setHoveredCommitOid((current) => (current === commit.oid ? null : current));
                  if (onCommitLeave) {
                    onCommitLeave();
                  }
                }}
              >
                <div className="shrink-0" style={{ width: rowGraphWidth, height: SWIMLANE_HEIGHT }}>
                  <svg
                    width={rowGraphWidth}
                    height={SWIMLANE_HEIGHT}
                    viewBox={`0 0 ${rowGraphWidth} ${SWIMLANE_HEIGHT}`}
                  >
                    {svgElements}
                  </svg>
                </div>

                <div className="flex items-center min-w-0 flex-1 gap-1.5" style={{ paddingLeft: 8 }}>
                  {referenceBadges.length > 0 ? (
                    <div className="flex shrink-0 items-center gap-1 max-w-[140px] min-w-0">
                      {referenceBadges.map((ref) => {
                        if (ref.worktreeCount) {
                          return (
                            <span
                              key={ref.key}
                              title={ref.worktreeNames?.join("\n")}
                              className="inline-flex shrink-0 items-center rounded-[10px] border px-1.5 text-[10px] font-medium"
                              style={{
                                borderColor: "color-mix(in srgb, var(--cs-text-secondary) 28%, transparent)",
                                color: "var(--cs-text-secondary)",
                                lineHeight: "16px",
                              }}
                            >
                              {ref.name}
                            </span>
                          );
                        }

                        const isColored = Boolean(ref.color);
                        const badgeBackground = isColored
                          ? ref.color
                          : "color-mix(in srgb, var(--cs-text-secondary) 18%, transparent)";
                        const badgeForeground = isColored
                          ? nodeInnerBackdrop
                          : "var(--cs-text-primary)";

                        return (
                          <span
                            key={ref.key}
                            className="inline-flex min-w-0 max-w-[100px] items-center rounded-[10px]"
                            style={{
                              background: badgeBackground,
                              color: badgeForeground,
                              lineHeight: "18px",
                              transition: "background-color 140ms ease, color 140ms ease",
                            }}
                          >
                            <span
                              className="truncate"
                              style={{
                                fontSize: 11,
                                paddingLeft: 6,
                                paddingRight: 6,
                                fontWeight: 500,
                              }}
                            >
                              {ref.name}
                            </span>
                          </span>
                        );
                      })}
                    </div>
                  ) : null}
                  <span
                    className="truncate flex-1 min-w-0"
                    style={{
                      fontSize: 12,
                      lineHeight: "15px",
                      color: "var(--cs-text-primary)",
                      fontWeight: isHead ? 600 : 400,
                    }}
                  >
                    {commit.summary}
                  </span>
                  <span
                    className="shrink-0"
                    style={{
                      fontSize: 11,
                      lineHeight: "14px",
                      color: "var(--cs-text-tertiary)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {commit.shortOid}
                  </span>
                </div>
              </div>
            </Dropdown>
          {isExpanded ? (
            <GitGraphChangedFiles
              files={expandedFiles}
              loading={expandedFilesLoading}
              error={expandedFilesError}
              graphWidth={rowGraphWidth}
              graphInset={ROW_HORIZONTAL_INSET}
              laneLines={outputSwimlanes.map((node, index) => ({
                x: SWIMLANE_WIDTH * (index + 1),
                color: node.color,
              }))}
              selectedFileKey={selectedFileKey}
              openingFileKey={openingFileKey}
              getFileKey={(file) => `${commit.oid}:${file.path}`}
              onFileSelect={(file) => onFileSelect?.(commit, file)}
            />
          ) : null}
        </div>
        );
      })}
        </div>
      </div>
    </div>
  );
}

export default GitGraphRenderer;
