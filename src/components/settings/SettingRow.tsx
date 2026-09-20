import type { ReactNode } from "react";

export function SettingRow({ label, desc, children }: {
  label: string;
  desc?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col items-stretch gap-3 px-4 py-3 xl:flex-row xl:items-center xl:justify-between">
      <div className="min-w-0 flex-1 xl:mr-4">
        <div className="text-sm text-[var(--cs-text-primary)]">{label}</div>
        {desc && (
          <div className="mt-0.5 text-[11px] text-[var(--cs-text-tertiary)]">{desc}</div>
        )}
      </div>
      <div className="min-w-0 xl:w-auto xl:max-w-[70%] xl:flex-shrink-0">
        {children}
      </div>
    </div>
  );
}
