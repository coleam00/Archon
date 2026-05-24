import { useState, type CSSProperties, type ReactNode, type SyntheticEvent } from 'react';

const STORAGE_PREFIX = 'archon-studio:nodelibrary-section:';

export interface CollapsibleSectionProps {
  /** Stable id used to persist open/closed state in localStorage. */
  id: string;
  title: string;
  /** Falls back to `true` when no persisted value exists. */
  defaultOpen?: boolean;
  /** When true (default), renders a 1px bottom divider matching the previous section chrome. */
  bordered?: boolean;
  children: ReactNode;
}

/**
 * Accordion-style wrapper backed by the native <details> element. Each instance
 * persists its open/closed state independently so the user's left-rail layout
 * survives page reloads.
 */
export function CollapsibleSection({
  id,
  title,
  defaultOpen = true,
  bordered = true,
  children,
}: CollapsibleSectionProps): JSX.Element {
  const storageKey = `${STORAGE_PREFIX}${id}`;
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored === 'true') return true;
      if (stored === 'false') return false;
    } catch {
      // Storage unavailable (Safari private mode, etc.) — fall back to default.
    }
    return defaultOpen;
  });

  const handleToggle = (e: SyntheticEvent<HTMLDetailsElement>): void => {
    const next = e.currentTarget.open;
    setOpen(next);
    try {
      localStorage.setItem(storageKey, String(next));
    } catch {
      // Storage unavailable — state persists in memory only.
    }
  };

  return (
    <details
      open={open}
      onToggle={handleToggle}
      style={{
        padding: 12,
        borderBottom: bordered ? '1px solid var(--studio-muted)' : undefined,
      }}
    >
      <summary style={summaryStyle}>
        <h3 style={headingStyle}>{title}</h3>
      </summary>
      <div style={{ marginTop: 8 }}>{children}</div>
    </details>
  );
}

const summaryStyle: CSSProperties = {
  cursor: 'pointer',
  outline: 'none',
};
const headingStyle: CSSProperties = {
  display: 'inline-block',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--studio-muted)',
  margin: 0,
};
