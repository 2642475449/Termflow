import { cloneElement, Fragment, isValidElement, useId, type ReactNode } from "react";

export function SettingRow({ label, description, htmlFor, children }: {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  const labelId = useId();
  const control = isValidElement<{ "aria-label"?: string; "aria-labelledby"?: string }>(children) && children.type !== Fragment
    ? cloneElement(children, { "aria-labelledby": children.props["aria-labelledby"] ?? (children.props["aria-label"] ? undefined : labelId) })
    : children;
  return (
    <div className="app-setting-row" role="group" aria-labelledby={labelId}>
      <div className="app-setting-row__label">
        {htmlFor ? <label id={labelId} htmlFor={htmlFor}>{label}</label> : <div id={labelId}>{label}</div>}
        {description && <div className="app-setting-row__description">{description}</div>}
      </div>
      <div className="app-setting-row__control">
        {control}
      </div>
    </div>
  );
}
