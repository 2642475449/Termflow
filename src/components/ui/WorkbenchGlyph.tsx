export type WorkbenchGlyphKind = "terminal" | "folder" | "git";

/** 小尺寸导航图标共享轮廓；可动画部分使用独立 SVG 图层。 */
export function WorkbenchGlyph({ kind }: { kind: WorkbenchGlyphKind }) {
  return (
    <svg className={`app-nav-artwork app-nav-artwork-${kind}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {kind === "terminal" && <>
        <rect x="3" y="4.5" width="18" height="15" rx="3" />
        <path d="m7 9 3 3-3 3" />
        <path className="app-nav-cursor" d="M13 15h4" />
      </>}
      {kind === "folder" && <>
        <path d="M3.5 17.5V6.8A1.8 1.8 0 0 1 5.3 5H10l2 2h6.7a1.8 1.8 0 0 1 1.8 1.8v8.7" />
        <path className="app-nav-folder-paper" d="M7.5 15V8.5h9V15" />
        <path className="app-nav-folder-front" d="M3.5 9.5h17v7.7a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8Z" />
      </>}
      {kind === "git" && <>
        <path d="M7 8v8" />
        <circle cx="7" cy="5.5" r="2.5" />
        <circle cx="7" cy="18.5" r="2.5" />
        <g className="app-nav-git-branch">
          <path d="M17 8v1.5c0 3-10 2-10 5" />
          <circle cx="17" cy="5.5" r="2.5" />
        </g>
      </>}
    </svg>
  );
}

export function WorkbenchEmptyArtwork({ kind }: { kind: "terminal" | "folder" }) {
  return (
    <svg className="app-empty-artwork" viewBox="0 0 112 80" fill="none" aria-hidden="true">
      <ellipse className="app-empty-ground" cx="56" cy="69" rx="35" ry="3" />
      <circle className="app-empty-accent" cx="91" cy="21" r="3" />
      <path className="app-empty-spark" d="M18 21v8m-4-4h8" />
      <g className="app-empty-object">
        {kind === "terminal" ? <>
          <rect className="app-empty-surface" x="23" y="16" width="66" height="47" rx="7" />
          <path className="app-empty-outline" d="M23 27h66" />
          <circle className="app-empty-accent" cx="31" cy="22" r="1.5" />
          <circle className="app-empty-muted" cx="37" cy="22" r="1.5" />
          <path className="app-empty-prompt" d="m36 38 6 6-6 6m14 0h14" />
        </> : <>
          <path className="app-empty-surface" d="M25 58V26a5 5 0 0 1 5-5h17l6 7h27a5 5 0 0 1 5 5v25Z" />
          <rect className="app-empty-paper" x="39" y="17" width="32" height="39" rx="4" />
          <path className="app-empty-outline" d="M46 25h18m-18 7h13" />
          <path className="app-empty-surface" d="M23 37h66l-5 23a5 5 0 0 1-5 4H33a5 5 0 0 1-5-4Z" />
          <path className="app-empty-prompt" d="M46 48h20" />
        </>}
      </g>
    </svg>
  );
}
