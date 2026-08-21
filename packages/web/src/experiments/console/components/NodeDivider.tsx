import type { ReactElement } from 'react';
import { formatElapsed, formatRelativeToBaseline, formatClock } from '../lib/format';
import { useStreamContext } from '../lib/stream-context';
import type { FanOutView } from '../primitives/event';

interface NodeDividerProps {
  /** `step_name` — the scroll-anchor target for the graph panel. */
  nodeId: string;
  nodeName: string;
  /** Folded lifecycle status; `running` = the node is still in-flight. */
  status: 'running' | 'completed' | 'failed' | 'skipped';
  durationMs: number | null;
  timestamp: string;
  /** From `node_completed` — surfaced inline so per-node spend is visible. */
  costUsd?: number | null;
  numTurns?: number | null;
  /** From `node_completed` — surfaced under the System detail toggle. */
  stopReason?: string | null;
  /** Only set for `skipped` — `when_condition` / `trigger_rule`. */
  skipReason?: string | null;
  /** Only set for `skipped` — the evaluated gating expression. */
  skipExpr?: string | null;
  /** When true, surface skip reason / stop reason inline. */
  showDetail?: boolean;
  /** Fan-out child report for a `workflow:` fan-out node (#2451); null otherwise. */
  fanOut?: FanOutView | null;
}

const STATUS_LABEL: Record<NodeDividerProps['status'], string> = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  skipped: 'skipped',
};

const STATUS_COLOR: Record<NodeDividerProps['status'], string> = {
  running: 'text-text-tertiary',
  completed: 'text-success',
  failed: 'text-error',
  skipped: 'text-text-tertiary',
};

/** Matches `FAN_OUT_ATTENTION_LINE_CAP` in the engine. Console cannot import that package. */
const FAN_OUT_CHILD_LINE_CAP = 20;

function formatFanOutTally(tally: FanOutView['tally']): string {
  const noun = tally.total === 1 ? 'child' : 'children';
  const headline = `${String(tally.notCompleted)} of ${String(tally.total)} ${noun} did not complete`;
  const parts: string[] = [];
  if (tally.completed > 0) parts.push(`${String(tally.completed)} completed`);
  if (tally.failed > 0) parts.push(`${String(tally.failed)} failed`);
  const cancelled = tally.cancelledByEngine + tally.cancelledOutOfBand;
  if (cancelled > 0) parts.push(`${String(cancelled)} cancelled`);
  if (tally.neverRan > 0) parts.push(`${String(tally.neverRan)} never ran`);
  return parts.length > 0 ? `${headline} (${parts.join(', ')})` : headline;
}

function formatFanOutChildLine(child: FanOutView['children'][number]): string {
  const shortId = 'childRunId' in child ? `${child.childRunId.slice(0, 8)} · ` : '';
  switch (child.kind) {
    case 'completed':
      return `[${String(child.index)}] completed · ${child.childRunId.slice(0, 8)}`;
    case 'failed':
      return `[${String(child.index)}] failed · ${shortId}${child.error}`;
    case 'cancelled_by_engine':
      return `[${String(child.index)}] cancelled (${child.reason}) · ${child.childRunId.slice(0, 8)}`;
    case 'cancelled_out_of_band':
      return `[${String(child.index)}] cancelled · ${shortId}${child.error ?? 'cancelled out of band'}`;
    case 'never_ran':
      return `[${String(child.index)}] never ran · ${child.error}`;
  }
}

/**
 * Thin divider heading one DAG node — exactly one per node, folded from its
 * transitions (started + terminal, plus any resume-time skip).
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
  numTurns,
  stopReason,
  skipReason,
  skipExpr,
  showDetail = false,
  fanOut = null,
}: NodeDividerProps): ReactElement {
  const { runStartedAt } = useStreamContext();
  const displayed = formatRelativeToBaseline(timestamp, runStartedAt);
  const wallClock = formatClock(timestamp);
  const dur =
    durationMs !== null && durationMs > 0
      ? ` · ${formatElapsed(Math.floor(durationMs / 1000))}`
      : '';
  // Per-node spend, surfaced inline next to the status. Sub-cent costs keep
  // more precision so cheap nodes don't all read "$0.00".
  const cost =
    costUsd !== null && costUsd !== undefined && costUsd > 0
      ? ` · $${costUsd >= 0.01 ? costUsd.toFixed(2) : costUsd.toFixed(4)}`
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

  // Fan-out attention (#2451): a `workflow:` fan-out node whose children did not all complete
  // shows the tally + the indexed non-completed child lines. A clean fan-out (notCompleted 0)
  // renders nothing extra — the node already reads "completed".
  const fanOutAttention = fanOut !== null && fanOut.tally.notCompleted > 0 ? fanOut : null;
  const fanOutLines =
    fanOutAttention === null
      ? []
      : fanOutAttention.children.filter(child => child.kind !== 'completed');
  const fanOutOverflow = Math.max(0, fanOutLines.length - FAN_OUT_CHILD_LINE_CAP);

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
      {fanOutAttention !== null ? (
        <div className="ml-[68px] flex flex-col gap-0.5 font-mono text-[10px] text-text-tertiary">
          <span className="text-warning">{formatFanOutTally(fanOutAttention.tally)}</span>
          {fanOutLines.slice(0, FAN_OUT_CHILD_LINE_CAP).map(child => (
            <span key={child.index} className="text-text-secondary">
              {formatFanOutChildLine(child)}
            </span>
          ))}
          {fanOutOverflow > 0 ? <span>{`+${String(fanOutOverflow)} more`}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
