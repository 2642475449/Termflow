export const GIT_GRAPH_HOVER_CARD_VIEWPORT_PADDING = 12;
export const GIT_GRAPH_HOVER_CARD_MAX_WIDTH = 760;
export const GIT_GRAPH_HOVER_CARD_MIN_WIDTH = 460;
export const GIT_GRAPH_HOVER_CARD_OFFSET = 8;
export const GIT_GRAPH_HOVER_CARD_ESTIMATED_HEIGHT = 340;

interface GitGraphHoverCardAnchor {
  top: number;
  right: number;
}

interface GitGraphHoverCardViewport {
  width: number;
  height: number;
}

export interface GitGraphHoverCardLayout {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

export function getGitGraphHoverCardLayout(
  anchor: GitGraphHoverCardAnchor,
  viewport: GitGraphHoverCardViewport,
  measuredHeight = GIT_GRAPH_HOVER_CARD_ESTIMATED_HEIGHT,
): GitGraphHoverCardLayout {
  const padding = GIT_GRAPH_HOVER_CARD_VIEWPORT_PADDING;
  const maxViewportWidth = Math.max(0, viewport.width - padding * 2);
  const preferredWidth = Math.min(GIT_GRAPH_HOVER_CARD_MAX_WIDTH, maxViewportWidth);
  const minimumWidth = Math.min(GIT_GRAPH_HOVER_CARD_MIN_WIDTH, maxViewportWidth);
  const availableRightWidth = Math.max(
    0,
    viewport.width - anchor.right - GIT_GRAPH_HOVER_CARD_OFFSET - padding,
  );
  const width = Math.min(
    preferredWidth,
    Math.max(minimumWidth, availableRightWidth),
  );
  const maximumLeft = Math.max(padding, viewport.width - width - padding);
  const left = Math.min(
    Math.max(anchor.right + GIT_GRAPH_HOVER_CARD_OFFSET, padding),
    maximumLeft,
  );

  const maxHeight = Math.max(0, viewport.height - padding * 2);
  const visibleHeight = Math.min(Math.max(0, measuredHeight), maxHeight);
  const maximumTop = Math.max(padding, viewport.height - visibleHeight - padding);
  const top = Math.min(Math.max(anchor.top - 6, padding), maximumTop);

  return { left, top, width, maxHeight };
}
