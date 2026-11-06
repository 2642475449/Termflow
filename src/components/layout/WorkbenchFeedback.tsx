import { useEffect, type ReactNode } from "react";
import { useWorkbenchFeedback } from "@/lib/workbenchFeedback";

export function WorkbenchFeedback({ children }: { children: ReactNode }) {
  const notice = useWorkbenchFeedback((state) => state.notice);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => {
      if (useWorkbenchFeedback.getState().notice === notice) {
        useWorkbenchFeedback.setState({ notice: null });
      }
    }, Math.max(0, notice.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [notice]);

  return <>
    <span role="status" aria-live="polite" aria-atomic="true"
      className={notice ? "min-w-0 truncate" : "sr-only"} title={notice?.text}>
      {notice?.text ?? ""}
    </span>
    <div className={notice ? "hidden" : "flex min-w-0 flex-1 items-center"}>
      {children}
    </div>
  </>;
}
