import type { ReactElement } from 'react';
import type { NodeRun } from '../primitives/event';
import { formatElapsed, formatRelativeToBaseline, formatClock } from '../lib/format';
import { useStreamContext } from '../lib/stream-context';
import type { CostScope } from '../primitives/event';

interface NodeDividerProps {
  /** `step_name` — the scroll-anchor target for the graph panel. */
  nodeId: string;
  nodeName: string;
  /** The engine's state for the node. */
  status: NodeRun['status'];
  durationMs: number | null;
  timestamp: string;
  /** From `node_completed` — surfaced inline so per-node spend is visible. */
  costUsd?: number | null;
  costScope?: CostScope;
  numTurns?: number | null;
  /** From `node_completed` — surfaced under the System detail toggle. */
  stopReason?: string | null;
  /** Only set for `skipped` — `when_condition` / `trigger_rule`. */
  skipReason?: string | null;
  /** Only set for `skipped` — the evaluated gating expression. */
  skipExpr?: string | null;
  /** When true, surface skip reason / stop reason inline. */
  showDetail?: boolean;
}

const STATUS_LABEL: Record<NodeDividerProps['status'], string> = {
  pending: 'pending',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  skipped: 'skipped',
};

const STATUS_COLOR: Record<NodeDividerProps['status'], string> = {
  pending: 'text-text-tertiary',
  running: 'text-text-tertiary',
  completed: 'text-success',
  failed: 'text-error',
  skipped: 'text-text-tertiary',
};

/**
 * Thin divider heading one DAG node — exactly one per node.
 *   left gutter:  relative timestamp (mono)
 *   left label:   node name in mono
 *   right label:  status + duration (when terminal)
 *
 * The id targets a scrollIntoView from the graph panel.
 */
export function NodeDivider({
  nodeId,
  nodeName,
  status,
  durationMs,
  timestamp,
  costUsd,
  costScope = 'own',
  numTurns,
  stopReason,
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
  // Per-node spend, surfaced inline next to the status. Sub-cent costs keep
  // more precision so cheap nodes don't all read "$0.00". A scope total restates
  // spend other nodes already show, so it is labelled rather than read as this
  // node's own.
  const cost =
    costUsd !== null && costUsd !== undefined && costUsd > 0
      ? ` · ${costScope === 'total' ? 'total ' : ''}$${costUsd >= 0.01 ? costUsd.toFixed(2) : costUsd.toFixed(4)}`
      : '';
  const turns =
    numTurns !== null && numTurns !== undefined && numTurns > 0 ? ` · ${numTurns}t` : '';

  const hasStopDetail =
    status !== 'skipped' &&
    showDetail &&
    stopReason !== null &&
    stopReason !== undefined &&
    stopReason.length > 0;

  const hasSkipDetail =
    status === 'skipped' &&
    showDetail &&
    skipReason !== null &&
    skipReason !== undefined &&
    skipReason.length > 0;

  // One divider per node now, so the scroll-anchor id is always present and
  // keyed by nodeId (matches the graph panel's getElementById target).
  return (
    <div
      id={`node-transition-${nodeId}`}
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
        <span className={`font-mono text-[11.5px] ${STATUS_COLOR[status]}`}>
          {STATUS_LABEL[status]}
          {dur}
          {cost}
          {turns}
        </span>
      </div>
      {hasStopDetail ? (
        <div className="ml-[68px] flex flex-wrap items-baseline gap-x-2 font-mono text-[10px] text-text-tertiary">
          <span>stop</span>
          <span className="text-text-secondary">{stopReason}</span>
        </div>
      ) : null}
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
