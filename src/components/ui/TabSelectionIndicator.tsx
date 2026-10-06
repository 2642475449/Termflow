import { useLayoutEffect, useRef, type RefObject } from "react";

interface TabSelectionIndicatorProps {
  listRef: RefObject<HTMLDivElement | null>;
  tabRefs: RefObject<Record<string, HTMLDivElement | null>>;
  activeTabId: string | null;
  tabIds: string[];
}

/** 指示线与标签处于同一个滚动坐标系，横向滚动时无需反复更新位置。 */
export function TabSelectionIndicator({ listRef, tabRefs, activeTabId, tabIds }: TabSelectionIndicatorProps) {
  const indicatorRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    const indicator = indicatorRef.current;
    if (!list || !indicator) return;
    let readyFrame: number | null = null;
    const update = () => {
      const target = activeTabId ? tabRefs.current[activeTabId] : null;
      indicator.dataset.visible = target ? "true" : "false";
      if (!target) {
        delete indicator.dataset.ready;
        return;
      }
      // 动态测量仅写入呈现变量，不改变标签、终端或 store 状态。
      indicator.style.setProperty("--cs-tab-indicator-x", `${target.offsetLeft}px`);
      indicator.style.setProperty("--cs-tab-indicator-width", `${target.offsetWidth}px`);
      if (indicator.dataset.ready !== "true" && readyFrame === null) {
        readyFrame = requestAnimationFrame(() => {
          indicator.dataset.ready = "true";
          readyFrame = null;
        });
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(list);
    for (const id of tabIds) {
      const tab = tabRefs.current[id];
      if (tab) observer.observe(tab);
    }
    return () => {
      observer.disconnect();
      if (readyFrame !== null) cancelAnimationFrame(readyFrame);
    };
  }, [activeTabId, tabIds, listRef, tabRefs]);

  return <span ref={indicatorRef} className="app-tab-selection-indicator" aria-hidden="true" />;
}
