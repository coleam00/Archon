import type { ReactElement } from 'react';
import { formatElapsed, formatRelativeToBaseline, formatClock } from '../lib/format';
import { useStreamContext } from '../lib/stream-context';

interface NodeDividerProps {
  nodeName: string;
  transition: 'started' | 'completed' | 'failed' | 'skipped';
  durationMs: number | null;
  timestamp: string;
}

const TRANSITION_LABEL: Record<NodeDividerProps['transition'], string> = {
  started: 'entered',
  completed: 'completed',
  failed: 'failed',
  skipped: 'skipped',
};

const TRANSITION_COLOR: Record<NodeDividerProps['transition'], string> = {
  started: 'text-[color:var(--running)]',
  completed: 'text-success',
  failed: 'text-error',
  skipped: 'text-text-tertiary',
};

/**
 * Thin divider marking a DAG node transition.
 *   left gutter:  relative timestamp (mono)
 *   left label:   node name in mono
 *   right label:  transition + duration (for completed/failed)
 *
 * The id targets a scrollIntoView from the graph panel.
 */
export function NodeDivider({
  nodeName,
  transition,
  durationMs,
  timestamp,
}: NodeDividerProps): ReactElement {
  const { runStartedAt } = useStreamContext();
  const displayed = formatRelativeToBaseline(timestamp, runStartedAt);
  const wallClock = formatClock(timestamp);
  const dur =
    durationMs !== null && durationMs > 0
      ? ` · ${formatElapsed(Math.floor(durationMs / 1000))}`
      : '';

  return (
    <div id={`node-transition-${nodeName}`} className="flex items-center gap-3 py-3">
      <time
        dateTime={timestamp}
        title={wallClock}
        className="w-14 shrink-0 font-mono text-[10px] tabular-nums text-text-tertiary"
      >
        {displayed}
      </time>
      <span className="font-mono text-[11px] text-text-primary">{nodeName}</span>
      <div
        className="h-px flex-1"
        style={{ backgroundColor: 'color-mix(in oklch, var(--border), transparent 50%)' }}
        aria-hidden
      />
      <span className={`font-mono text-[11px] ${TRANSITION_COLOR[transition]}`}>
        {TRANSITION_LABEL[transition]}
        {dur}
      </span>
    </div>
  );
}
