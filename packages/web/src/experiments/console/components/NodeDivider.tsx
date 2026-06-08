import type { ReactElement } from 'react';
import { formatElapsed, formatRelativeToBaseline, formatClock } from '../lib/format';
import { useStreamContext } from '../lib/stream-context';

interface NodeDividerProps {
  nodeName: string;
  transition: 'started' | 'completed' | 'failed' | 'skipped';
  durationMs: number | null;
  timestamp: string;
  /** Only set for `skipped` — `when_condition` / `trigger_rule`. */
  skipReason?: string | null;
  /** Only set for `skipped` — the evaluated gating expression. */
  skipExpr?: string | null;
  /** When true, surface skip reason + expression inline. */
  showDetail?: boolean;
}

const TRANSITION_LABEL: Record<NodeDividerProps['transition'], string> = {
  started: 'entered',
  completed: 'completed',
  failed: 'failed',
  skipped: 'skipped',
};

const TRANSITION_COLOR: Record<NodeDividerProps['transition'], string> = {
  started: 'text-text-tertiary',
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
  skipReason,
  skipExpr,
  showDetail = false,
}: NodeDividerProps): ReactElement {
  const { runStartedAt } = useStreamContext();
  const displayed = formatRelativeToBaseline(timestamp, runStartedAt);
  const wallClock = formatClock(timestamp);
  const dur =
    durationMs !== null && durationMs > 0
      ? ` · ${formatElapsed(Math.floor(durationMs / 1000))}`
      : '';

  const hasSkipDetail =
    transition === 'skipped' &&
    showDetail &&
    skipReason !== null &&
    skipReason !== undefined &&
    skipReason.length > 0;

  // Only the `started` transition carries the scroll-anchor id so the graph
  // click jumps to the node's entry point, not its later `completed` /
  // `failed` markers — and so duplicate ids never appear in the DOM when a
  // node emits multiple transitions.
  return (
    <div
      id={transition === 'started' ? `node-transition-${nodeName}` : undefined}
      className="flex flex-col gap-1 border-b border-border/60 py-[11px]"
    >
      <div className="flex items-center gap-4">
        <time
          dateTime={timestamp}
          title={wallClock}
          className="w-14 shrink-0 font-mono text-[11.5px] tabular-nums text-text-tertiary"
        >
          {displayed}
        </time>
        <span className="font-mono text-[13px] font-semibold text-text-primary">{nodeName}</span>
        {/* Dashed leader line (design v3 .log-line). */}
        <div
          className="h-px flex-1"
          style={{
            background:
              'repeating-linear-gradient(90deg, var(--border) 0 4px, transparent 4px 8px)',
          }}
          aria-hidden
        />
        <span className={`font-mono text-[11.5px] ${TRANSITION_COLOR[transition]}`}>
          {TRANSITION_LABEL[transition]}
          {dur}
        </span>
      </div>
      {hasSkipDetail ? (
        <div className="ml-[68px] flex flex-wrap items-baseline gap-x-2 font-mono text-[10px] text-text-tertiary">
          <span>reason</span>
          <span className="text-text-secondary">{skipReason}</span>
          {skipExpr !== null && skipExpr !== undefined && skipExpr.length > 0 ? (
            <>
              <span>expr</span>
              <span className="text-text-secondary">{skipExpr}</span>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
