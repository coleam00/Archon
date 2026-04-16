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

const KIND_STYLES: Record<
  StreamCardProps['kind'],
  { label: string; pill: string; border: string }
> = {
  user: {
    label: 'You',
    pill: 'bg-surface-elevated text-text-primary',
    border: 'border-border',
  },
  assistant: {
    label: 'Agent',
    pill: 'bg-surface-elevated text-text-primary',
    border: 'border-border',
  },
  system: {
    label: 'System',
    pill: 'bg-surface-elevated text-text-tertiary',
    border: 'border-border',
  },
  tool: {
    label: 'Tool',
    pill: 'bg-surface-inset text-text-secondary',
    border: 'border-border/60',
  },
  artifact: {
    label: 'Artifact',
    pill: 'bg-success/15 text-success',
    border: 'border-success/30',
  },
  error: {
    label: 'Error',
    pill: 'bg-error/15 text-error',
    border: 'border-error/30',
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
      className={`rounded border ${style.border} bg-surface px-3 ${
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
