import type { ReactElement } from 'react';
import { runPhaseStart, type Run } from '../primitives/run';
import { statusTextClass } from '../lib/run-status';
import { formatElapsed, elapsedSince, formatCost, formatDateTime, ensureUtc } from '../lib/format';
import { RunOutcomeBadge } from './RunOutcomeBadge';

/**
 * Lifecycle bookends for the run log. The node transitions in between are
 * already rendered by RunStream (NodeDivider); these mark where the run began
 * and how it ended so the log is a complete story rather than a tool dump.
 */
export function RunStartedLine({ run }: { run: Run }): ReactElement {
  return (
    <>
      <div className="flex items-center gap-2 py-1 text-console-11">
        <span aria-hidden className="text-[color:var(--running)]">
          ▶
        </span>
        <span className="font-medium text-text-secondary">Workflow {run.workflow} started</span>
        <time className="font-mono text-text-tertiary" dateTime={ensureUtc(run.startedAt)}>
          {formatDateTime(run.startedAt)}
        </time>
        <div className="h-px flex-1 bg-border/50" aria-hidden />
      </div>
      {run.userMessage !== '' ? (
        <div className="ml-1.75 border-l-2 border-border/60 pl-3 text-console-11 text-text-tertiary">
          {run.userMessage}
        </div>
      ) : null}
    </>
  );
}

const TERMINAL = new Set<Run['status']>(['completed', 'failed', 'cancelled']);
const GLYPH: Record<string, string> = { completed: '✓', failed: '✕', cancelled: '◌' };
const LABEL: Record<string, string> = {
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function RunFinishedLine({ run }: { run: Run }): ReactElement | null {
  if (!TERMINAL.has(run.status)) return null;
  const duration = formatElapsed(elapsedSince(runPhaseStart(run), run.finishedAt ?? undefined));
  const cost =
    run.costUsd !== null ? ` · Reported cost ${formatCost(run.costUsd)} (may be partial)` : '';

  // The engine's own account of why the run failed. A failed node shows its error on
  // its own row; a launch failure has no node and no message to carry the reason, so
  // without this the log ends on a bare "Failed".
  const record = run.status === 'failed' ? run.terminalRecord : null;
  const failure = record?.first_failed_node == null ? (record?.error ?? null) : null;

  return (
    <>
      <div className="mt-2 flex flex-wrap items-center gap-2 py-1 text-console-11">
        <div className="h-px flex-1 bg-border/50" aria-hidden />
        <span aria-hidden className={statusTextClass[run.status]}>
          {GLYPH[run.status]}
        </span>
        <span className={`font-medium ${statusTextClass[run.status]}`}>{LABEL[run.status]}</span>
        <RunOutcomeBadge outcome={run.outcome} terminalRecord={run.terminalRecord} />
        <span className="font-mono text-text-tertiary">
          in {duration}
          {run.activePhaseStartedAt != null ? ' since it last started' : ''}
          {cost}
        </span>
      </div>
      {failure !== null && failure !== '' ? (
        <div role="alert" className="mt-2 rounded border border-error/30 bg-error/[0.06] px-4 py-3">
          <p className="text-console-10 font-semibold uppercase tracking-console-label text-error">
            Why it failed
          </p>
          <p className="mt-1 whitespace-pre-wrap font-mono text-console-12 text-text-primary [overflow-wrap:anywhere]">
            {failure}
          </p>
        </div>
      ) : null}
    </>
  );
}
