interface ShortcutHintProps {
  keys: string;
}

export function ShortcutHint({ keys }: ShortcutHintProps) {
  const parts = keys.split(" + ");
  return (
    <span className="inline-flex items-center gap-0.5 ml-2">
      {parts.map((k, i) => (
        <span key={i} className="inline-flex items-center">
          <kbd
            className="inline-block px-1 py-px rounded text-[10px] font-mono leading-tight"
            style={{
              background: "var(--cs-bg-hover)",
              color: "var(--cs-text-tertiary)",
              boxShadow: "0 1px 1px rgba(0,0,0,0.04)",
            }}
          >
            {k}
          </kbd>
          {i < parts.length - 1 && (
            <span
              className="text-[9px] mx-px"
              style={{ color: "var(--cs-text-tertiary)" }}
            >
              +
            </span>
          )}
        </span>
      ))}
    </span>
  );
}
