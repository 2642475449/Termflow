import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_BOTTOM_RUNNER_HEIGHT, useBottomRunnerStore } from "@/store/slices/bottomRunner";

export function syncRunnerLayout(sessionId?: string | null) {
  window.dispatchEvent(new CustomEvent("terminal:layout-sync", {
    detail: { sessionId, reason: "bottom-runner-resize" },
  }));
}

export function BottomRunnerDivider({ activeSessionId }: { activeSessionId?: string | null }) {
  const { t } = useTranslation();
  const drag = useRef<{ y: number; height: number } | null>(null);
  const height = useBottomRunnerStore((state) => state.height);
  return <div role="separator" aria-label={t("bottomRunner.resize")} aria-orientation="horizontal"
    aria-valuemin={120} aria-valuemax={650} aria-valuenow={height} tabIndex={0}
    className="app-bottom-runner-divider h-1 shrink-0 cursor-row-resize touch-none"
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { y: event.clientY, height: useBottomRunnerStore.getState().height };
      useBottomRunnerStore.getState().setMaximized(false);
    }}
    onPointerMove={(event) => {
      if (drag.current) useBottomRunnerStore.getState().setHeight(drag.current.height + drag.current.y - event.clientY);
    }}
    onLostPointerCapture={() => { drag.current = null; syncRunnerLayout(); }}
    onPointerUp={(event) => {
      drag.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
      syncRunnerLayout(activeSessionId);
      syncRunnerLayout();
    }}
    onDoubleClick={() => {
      useBottomRunnerStore.getState().setMaximized(false);
      useBottomRunnerStore.getState().setHeight(DEFAULT_BOTTOM_RUNNER_HEIGHT);
      syncRunnerLayout();
    }}
    onKeyDown={(event) => {
      if (!["ArrowUp", "ArrowDown", "Home"].includes(event.key)) return;
      event.preventDefault();
      const store = useBottomRunnerStore.getState();
      store.setMaximized(false);
      store.setHeight(event.key === "Home" ? DEFAULT_BOTTOM_RUNNER_HEIGHT : store.height + (event.key === "ArrowUp" ? 20 : -20));
      syncRunnerLayout();
    }} />;
}
