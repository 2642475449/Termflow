import { Component, type ErrorInfo, type ReactNode } from "react";
import i18n from "@/i18n";

interface ErrorBoundaryProps {
  children: ReactNode;
  scope: string;
  onClose?: () => void;
}

// Use native controls so recovery also works if a UI provider fails.
export class ErrorBoundary extends Component<ErrorBoundaryProps, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[Termflow:${this.props.scope}]`, error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="flex h-full min-h-[180px] flex-col items-center justify-center gap-3 p-6"
        style={{ color: "var(--cs-text-primary)", background: "var(--cs-bg-content)" }}>
        <strong>{i18n.t("errorBoundary.title")}</strong>
        <p>{i18n.t("errorBoundary.description")}</p>
        <pre className="max-h-40 max-w-full overflow-auto whitespace-pre-wrap text-xs">{String(this.state.error)}</pre>
        <div className="flex gap-3">
          <button className="cursor-pointer rounded border px-3 py-1" onClick={() => this.setState({ error: null })}>
            {i18n.t("errorBoundary.retry")}
          </button>
          {this.props.onClose ? (
            <button className="cursor-pointer rounded border px-3 py-1" onClick={this.props.onClose}>
              {i18n.t("errorBoundary.closeTab")}
            </button>
          ) : (
            <button className="cursor-pointer rounded border px-3 py-1" onClick={() => window.location.reload()}>
              {i18n.t("errorBoundary.reload")}
            </button>
          )}
        </div>
      </div>
    );
  }
}
