import type { ReactNode } from "react";
import { DownOutlined } from "@ant-design/icons";

export function VoiceSettingsSection({ title, actions, children }: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="app-voice-settings-section overflow-hidden rounded-xl border border-[var(--cs-border-card)] bg-[var(--cs-bg-card)]">
      <header className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b border-[var(--cs-border-card)] px-4 py-3">
        <h2 className="m-0 text-sm font-semibold text-[var(--cs-text-primary)]">{title}</h2>
        {actions}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function VoiceSettingsField({ label, htmlFor, children }: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="app-voice-settings-field min-w-0 space-y-2">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-[var(--cs-text-secondary)]">{label}</label>
      {children}
    </div>
  );
}

export function VoiceSettingsDisclosure({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="app-voice-settings-disclosure group">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-2 rounded py-1 text-xs font-medium text-[var(--cs-text-secondary)] hover:text-[var(--cs-text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--cs-primary)] [&::-webkit-details-marker]:hidden">
        <DownOutlined aria-hidden="true" className="text-[10px] group-open:rotate-180" />
        {title}
      </summary>
      <div className="pt-3">{children}</div>
    </details>
  );
}
