export interface NavigableTreeNode {
  entry: { path: string; kind: string };
  isExpanded: boolean;
  children: NavigableTreeNode[];
}

export function getTreeNavigation(
  nodes: NavigableTreeNode[],
  currentPath: string | null,
  key: string,
  searchMode = false,
): { type: "select" | "expand" | "collapse" | "open"; path: string } | null {
  const rows: { node: NavigableTreeNode; parent: string | null }[] = [];
  const visit = (items: NavigableTreeNode[], parent: string | null) => {
    for (const node of items) {
      rows.push({ node, parent });
      if (node.isExpanded) visit(node.children, node.entry.path);
    }
  };
  visit(nodes, null);
  if (!rows.length) return null;
  const index = rows.findIndex(({ node }) => node.entry.path === currentPath);
  const select = (position: number) => ({ type: "select" as const, path: rows[position].node.entry.path });
  if (key === "Home") return select(0);
  if (key === "End") return select(rows.length - 1);
  if (key === "ArrowDown") return select(index < 0 ? 0 : Math.min(index + 1, rows.length - 1));
  if (key === "ArrowUp") return select(index < 0 ? rows.length - 1 : Math.max(index - 1, 0));
  if (!["ArrowLeft", "ArrowRight", "Enter"].includes(key)) return null;
  if (index < 0) return select(0);
  const { node, parent } = rows[index];
  const path = node.entry.path;
  const directory = node.entry.kind === "directory";
  if (key === "Enter") {
    if (!directory) return { type: "open", path };
    if (!searchMode) return { type: node.isExpanded ? "collapse" : "expand", path };
  }
  if (key === "ArrowRight" && directory) {
    if (!node.isExpanded && !searchMode) return { type: "expand", path };
    if (node.children.length) return { type: "select", path: node.children[0].entry.path };
  }
  if (key === "ArrowLeft") {
    if (directory && node.isExpanded && !searchMode) return { type: "collapse", path };
    if (parent) return { type: "select", path: parent };
  }
  return null;
}
