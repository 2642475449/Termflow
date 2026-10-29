interface SettingsPageHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  decoration?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}

export function SettingsPageHeader({
  title,
  description,
  decoration,
  actions,
  children,
}: SettingsPageHeaderProps) {
  return (
    <header className="app-settings-page-header">
      <div className="app-settings-page-header__main">
        <div className="min-w-0 flex-1">
          <h1 className="app-settings-page-header__title">{title}</h1>
          {description && <p className="app-settings-page-header__description">{description}</p>}
        </div>
        {actions ? (
          <div className="app-settings-page-header__actions">
            {actions}
          </div>
        ) : null}
        {decoration && <div className="app-settings-page-header__decoration" aria-hidden="true">{decoration}</div>}
      </div>

      {children ? (
        <div className="app-settings-toolbar">
          {children}
        </div>
      ) : null}
    </header>
  );
}
