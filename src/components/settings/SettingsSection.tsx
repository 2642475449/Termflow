import { useId, type ReactNode } from "react";
import { DownOutlined } from "@ant-design/icons";

interface SettingsSectionProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** 设置页统一使用细线分组；不增加卡片背景或阴影。 */
export function SettingsSection({ title, description, actions, children, className = "" }: SettingsSectionProps) {
  const titleId = useId();
  return (
    <section className={`app-settings-section ${className}`} aria-labelledby={titleId}>
      <header className="app-settings-section__header">
        <div className="min-w-0">
          <h2 id={titleId} className="app-settings-section__title">{title}</h2>
          {description && <div className="app-settings-section__description">{description}</div>}
        </div>
        {actions && <div className="app-settings-section__actions">{actions}</div>}
      </header>
      <div className="app-settings-section__body">{children}</div>
    </section>
  );
}

export function SettingsField({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="app-settings-field">
      <label htmlFor={htmlFor} className="app-settings-field__label">{label}</label>
      {children}
    </div>
  );
}

export function SettingsDisclosure({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="app-settings-disclosure group">
      <summary>
        <DownOutlined aria-hidden="true" className="text-[10px] group-open:rotate-180" />
        {title}
      </summary>
      <div className="pt-3">{children}</div>
    </details>
  );
}
