/**
 * New files have no meaningful original document. Render their diff inline so
 * the added content can use the full editor width instead of reserving an
 * empty original pane.
 */
export function shouldRenderGitDiffSideBySide(
  changeKind: string | null | undefined,
) {
  return changeKind !== "added" && changeKind !== "untracked";
}
