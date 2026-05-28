import type { ReactElement, ReactNode } from 'react';
import { formatClock, formatRelativeToBaseline } from '../lib/format';
import { useStreamContext } from '../lib/stream-context';

interface StreamCardProps {
  timestamp: string;
  kind: 'user' | 'assistant' | 'system' | 'tool' | 'artifact' | 'error';
  /** Optional extra element rendered in the header row, right-aligned. */
  headerRight?: ReactNode;
  /** Label override. Defaults to the kind, uppercased. */
  label?: string;
  children?: ReactNode;
  /** Tighter padding + no header margin; header sits on the same row as the only content. */
  compact?: boolean;
  /** Click handler — makes the whole card a clickable affordance (tool-call expand). */
  onClick?: () => void;
}

// Role pills carry the brand duotone: the user's voice reads as magenta
// (presence / authorship); the agent's voice reads as teal (execution).
// Tool/system/artifact/error stay semantic — they signal kind-of-event, not
// who-is-speaking.
//
// border-color is set inline (not via Tailwind class) because the console's
// wildcard `border-color: var(--border)` rule outweighs utility-class color
// in the cascade and would otherwise repaint everything charcoal.
interface KindStyle {
  label: string;
  pill: string;
  borderClass: string;
  borderColor: string;
}

const KIND_STYLES: Record<StreamCardProps['kind'], KindStyle> = {
  user: {
    label: 'You',
    pill: 'bg-[color:var(--accent-soft)] text-[color:var(--brand-magenta)]',
    borderClass: 'border',
    borderColor: 'var(--border)',
  },
  assistant: {
    label: 'Agent',
    pill: 'bg-[color:var(--success-soft,oklch(0.755_0.165_168/0.14))] text-[color:var(--brand-teal)]',
    borderClass: 'border',
    borderColor: 'var(--border)',
  },
  system: {
    label: 'System',
    pill: 'bg-[color:var(--success-soft,oklch(0.755_0.165_168/0.14))] text-[color:var(--brand-teal)]',
    // Top-only teal hairline anchors system rows as framework bookends
    // without shouting. Other sides are intentionally omitted.
    borderClass: 'border-t',
    borderColor: 'color-mix(in oklch, var(--brand-teal), transparent 55%)',
  },
  tool: {
    label: 'Tool',
    pill: 'bg-surface-inset text-text-secondary',
    borderClass: 'border',
    borderColor: 'color-mix(in oklch, var(--border), transparent 40%)',
  },
  artifact: {
    label: 'Artifact',
    pill: 'bg-success/15 text-success',
    borderClass: 'border',
    borderColor: 'color-mix(in oklch, var(--success), transparent 70%)',
  },
  error: {
    label: 'Error',
    pill: 'bg-error/15 text-error',
    borderClass: 'border',
    borderColor: 'color-mix(in oklch, var(--error), transparent 60%)',
  },
};

/**
 * Shared small-card shell for every entry in the run stream. Consistent
 * header (timestamp + role pill) with variant-specific body.
 */
export function StreamCard({
  timestamp,
  kind,
  headerRight,
  label,
  children,
  compact = false,
  onClick,
}: StreamCardProps): ReactElement {
  const style = KIND_STYLES[kind];
  const { runStartedAt } = useStreamContext();
  const displayed = formatRelativeToBaseline(timestamp, runStartedAt);
  const wallClock = formatClock(timestamp);
  return (
    <article
      onClick={onClick}
      style={{ borderColor: style.borderColor }}
      className={`rounded ${style.borderClass} bg-surface px-3 ${
        compact ? 'py-1.5' : 'py-2'
      } ${onClick !== undefined ? 'cursor-pointer transition-colors hover:bg-surface-hover' : ''}`}
    >
      <header className={`flex items-center gap-2 ${compact ? '' : 'mb-1.5'}`}>
        <time
          dateTime={timestamp}
          title={wallClock}
          className="font-mono text-[10px] tabular-nums text-text-tertiary"
        >
          {displayed}
        </time>
        <span
          className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] ${style.pill}`}
        >
          {label ?? style.label}
        </span>
        {headerRight !== undefined ? (
          <div className="ml-auto flex items-center gap-2">{headerRight}</div>
        ) : null}
      </header>
      {children}
    </article>
  );
}
