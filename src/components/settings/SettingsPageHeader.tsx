interface SettingsPageHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}

export function SettingsPageHeader({
  title,
  description,
  actions,
  children,
}: SettingsPageHeaderProps) {
  return (
    <div
      className="app-glass-card mb-6 overflow-hidden rounded-xl"
      style={{
        background: "var(--cs-bg-card)",
        border: "1px solid var(--cs-border-card)",
        boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-5">
        <div className="min-w-0 flex-1">
          <div
            className="text-xl font-semibold leading-tight"
            style={{ color: "var(--cs-text-primary)" }}
          >
            {title}
          </div>
          {description ? (
            <div
              className="mt-2 max-w-3xl text-sm leading-6"
              style={{ color: "var(--cs-text-tertiary)" }}
            >
              {description}
            </div>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-start gap-2">
            {actions}
          </div>
        ) : null}
      </div>

      {children ? (
        <div
          className="px-5 py-4"
          style={{
            borderTop: "1px solid var(--cs-border-card)",
            background: "color-mix(in srgb, var(--cs-bg-card) 88%, var(--cs-bg-hover) 12%)",
          }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
