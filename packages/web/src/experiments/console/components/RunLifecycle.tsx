import type { ReactElement } from 'react';
import type { Run } from '../primitives/run';
import { statusTextClass } from '../lib/run-status';
import { formatElapsed, elapsedSince, formatCost, formatClock } from '../lib/format';

/**
 * Lifecycle bookends for the run log. The node transitions in between are
 * already rendered by RunStream (NodeDivider); these mark where the run began
 * and how it ended so the log is a complete story rather than a tool dump.
 */
export function RunStartedLine({ run }: { run: Run }): ReactElement {
  return (
    <>
      <div className="flex items-center gap-2 py-1 text-[11px]">
        <span aria-hidden className="text-[color:var(--running)]">
          ▶
        </span>
        <span className="font-medium text-text-secondary">Workflow {run.workflow} started</span>
        <span className="font-mono text-text-tertiary">{formatClock(run.startedAt)}</span>
        <div className="h-px flex-1 bg-border/50" aria-hidden />
      </div>
      {run.userMessage !== '' ? (
        <div className="ml-[7px] border-l-2 border-border/60 pl-3 text-[11px] text-text-tertiary">
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
  const duration = formatElapsed(elapsedSince(run.startedAt, run.finishedAt ?? undefined));
  const cost = run.costUsd !== null ? ` · ${formatCost(run.costUsd)}` : '';

  return (
    <div className="mt-2 flex items-center gap-2 py-1 text-[11px]">
      <div className="h-px flex-1 bg-border/50" aria-hidden />
      <span aria-hidden className={statusTextClass[run.status]}>
        {GLYPH[run.status]}
      </span>
      <span className={`font-medium ${statusTextClass[run.status]}`}>{LABEL[run.status]}</span>
      <span className="font-mono text-text-tertiary">
        in {duration}
        {cost}
      </span>
    </div>
  );
}
