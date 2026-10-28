import type { ReactElement } from 'react';
import { Link } from 'react-router';
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
  costPartial?: NodeRun['costPartial'];
  costScope?: CostScope | null;
  numTurns?: number | null;
  tokens?: NodeRun['tokens'];
  /** From `node_completed` — surfaced under the System detail toggle. */
  stopReason?: string | null;
  /** Only set for `skipped` — `when_condition` / `trigger_rule`. */
  skipReason?: string | null;
  /** Only set for `skipped` — the evaluated gating expression. */
  skipExpr?: string | null;
  /** A fan-out node's slot record; unfinished child work qualifies a completed node. */
  fanOutOutcome?: NodeRun['fanOutOutcome'];
  /** When true, surface skip reason / stop reason inline. */
  showDetail?: boolean;
}

type FanOutOutcome = NonNullable<NodeRun['fanOutOutcome']>;
type FanOutSlotOutcome = FanOutOutcome['slots'][number]['outcome'];

const FAN_OUT_SLOT_LABEL: Record<FanOutSlotOutcome, string> = {
  completed: 'completed',
  failed: 'failed',
  not_started: 'not started',
  cancelled_by_engine: 'cancelled by the engine',
  cancelled_by_workflow: 'cancelled by its own workflow',
  cancelled_out_of_band: 'cancelled out of band',
  cancelled_unattributed: 'cancelled, cause not recorded',
};

const FAN_OUT_SLOT_DISPLAY_LIMIT = 10;

/** Unfinished child work under a fan-out node; the "more" count comes from the stored tally. */
function FanOutQualifier({ outcome }: { outcome: NodeRun['fanOutOutcome'] }): ReactElement | null {
  if (outcome === undefined) return null;
  const { tally } = outcome;
  const unfinished = tally.total - tally.completed;
  if (unfinished === 0) return null;
  const counts = (Object.keys(FAN_OUT_SLOT_LABEL) as FanOutSlotOutcome[])
    .filter(key => key !== 'completed' && tally[key] > 0)
    .map(key => `${String(tally[key])} ${FAN_OUT_SLOT_LABEL[key]}`);
  const shown = outcome.slots
    .filter(slot => slot.outcome !== 'completed')
    .slice(0, FAN_OUT_SLOT_DISPLAY_LIMIT);
  const more = unfinished - shown.length;
  return (
    <details className="ml-[68px] font-mono text-[11px] text-warning">
      <summary className="cursor-pointer">
        {`${String(unfinished)} of ${String(tally.total)} children did not complete (${counts.join(', ')})`}
      </summary>
      <ul className="mt-1 flex flex-col gap-0.5 text-text-secondary">
        {shown.map(slot => (
          <li key={slot.index}>
            {`item ${String(slot.index)}: ${FAN_OUT_SLOT_LABEL[slot.outcome]}`}
            {'cancel_reason' in slot && slot.cancel_reason ? ` (${slot.cancel_reason})` : ''}
            {'child_run_id' in slot ? (
              <>
                {' — '}
                <Link className="underline" to={`/console/r/${slot.child_run_id}`}>
                  {`run ${slot.child_run_id.slice(0, 8)}`}
                </Link>
              </>
            ) : null}
            {'error' in slot && slot.error ? ` — ${slot.error}` : ''}
          </li>
        ))}
        {more > 0 ? <li>{`and ${String(more)} more`}</li> : null}
      </ul>
    </details>
  );
}

const tokenCount = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

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

// Per-node spend, surfaced inline next to the status. Sub-cent costs keep
// more precision so cheap nodes don't all read "$0.00". A scope total restates
// spend other nodes already show, so it is labelled rather than read as this
// node's own.
function formatNodeCost(
  costUsd: NodeDividerProps['costUsd'],
  costScope: NodeDividerProps['costScope'],
  costPartial: NodeDividerProps['costPartial']
): string {
  if (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0) return '';
  const digits = costUsd >= 0.01 ? 2 : 4;
  let amount = costUsd.toFixed(digits);
  if (costPartial && Number(amount) > costUsd) {
    amount = (Number(amount) - 10 ** -digits).toFixed(digits);
  }
  return ` · ${costScope === 'total' ? 'total ' : ''}${costPartial ? 'at least ' : ''}$${amount}`;
}

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
  costPartial,
  costScope,
  numTurns,
  tokens,
  stopReason,
  skipReason,
  skipExpr,
  fanOutOutcome,
  showDetail = false,
}: NodeDividerProps): ReactElement {
  const { runStartedAt } = useStreamContext();
  const displayed = formatRelativeToBaseline(timestamp, runStartedAt);
  const wallClock = formatClock(timestamp);
  const dur =
    durationMs !== null && durationMs > 0
      ? ` · ${formatElapsed(Math.floor(durationMs / 1000))}`
      : '';
  const cost = formatNodeCost(costUsd, costScope, costPartial);
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
          {tokens ? (
            <span
              title={`${tokens.input.toLocaleString('en')} input tokens / ${tokens.output.toLocaleString('en')} output tokens`}
            >
              {` · tokens ${tokenCount.format(tokens.input)} in / ${tokenCount.format(tokens.output)} out`}
            </span>
          ) : null}
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
      <FanOutQualifier outcome={fanOutOutcome} />
    </div>
  );
}
