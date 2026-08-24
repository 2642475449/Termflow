import type { CSSProperties } from "react";

interface GitIconProps {
  className?: string;
  size?: number | string;
  style?: CSSProperties;
}

/** The Git mark, kept separate from provider-specific GitHub branding. */
export function GitIcon({ className, size = "1em", style }: GitIconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      focusable="false"
      role="img"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      style={style}
    >
      <path d="M23.546 10.93 13.067.452a1.548 1.548 0 0 0-2.188 0L8.708 2.623l2.76 2.76a1.838 1.838 0 0 1 1.897.448 1.84 1.84 0 0 1 .448 1.897l2.658 2.658a1.84 1.84 0 0 1 1.897.449 1.856 1.856 0 0 1 0 2.625 1.856 1.856 0 0 1-2.624 0 1.86 1.86 0 0 1-.401-2.01l-2.479-2.479v6.526c.175.086.341.202.488.349a1.856 1.856 0 0 1 0 2.625 1.856 1.856 0 0 1-2.624 0 1.856 1.856 0 0 1 0-2.625c.18-.18.387-.315.608-.405V8.85a1.851 1.851 0 0 1-1.002-2.428L7.611 3.706.453 10.864a1.548 1.548 0 0 0 0 2.188l10.478 10.479a1.548 1.548 0 0 0 2.187 0l10.428-10.429a1.537 1.537 0 0 0 0-2.172Z" />
    </svg>
  );
}
