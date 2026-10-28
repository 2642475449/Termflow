interface ShortcutHintProps {
  keys: string;
}

export function ShortcutHint({ keys }: ShortcutHintProps) {
  const parts = keys.split(/\s*\+\s*/);
  return (
    <span className="inline-flex items-center gap-0.5">
      {parts.map((k, i) => (
        <span key={i} className="inline-flex items-center">
          <kbd
            className="inline-block rounded bg-[var(--cs-bg-hover)] px-1 py-px text-[10px] font-mono leading-tight text-[var(--cs-text-secondary)]"
          >
            {k}
          </kbd>
          {i < parts.length - 1 && (
            <span
              className="mx-px text-[9px] text-[var(--cs-text-secondary)]"
            >
              +
            </span>
          )}
        </span>
      ))}
    </span>
  );
}
