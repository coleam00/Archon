import type { ReactElement } from 'react';
import { useNavigate } from 'react-router';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import * as skill from '../skills';
import type { RunEvent } from '../primitives/event';
import type { RunStatus } from '../lib/run-status';
import { statusTextClass, statusLabel } from '../lib/run-status';
import { formatElapsed, elapsedSince, formatCost } from '../lib/format';

interface ConsoleWorkflowResultCardProps {
  runId: string;
  workflowName: string;
  /** The orchestrator's summary prose (the message content). Rendered as the body. */
  summary: string;
}

const RESULT_GLYPH: Partial<Record<RunStatus, string>> = {
  completed: '✓',
  failed: '✕',
  cancelled: '◌',
};

const RESULT_LABEL: Partial<Record<RunStatus, string>> = {
  completed: 'Workflow complete',
  failed: 'Workflow failed',
  cancelled: 'Workflow cancelled',
};

/** Count terminal node transitions (completed/failed/skipped); `started` is in-flight. */
function countTerminalNodes(events: RunEvent[]): { completed: number; total: number } {
  let completed = 0;
  let total = 0;
  for (const e of events) {
    if (e.kind !== 'node_transition' || e.transition === 'started') continue;
    total += 1;
    if (e.transition === 'completed') completed += 1;
  }
  return { completed, total };
}

/**
 * A formatted card for a `workflow_result` chat message: status + node counts +
 * duration + cost + a link to the run detail, with the summary prose as the body.
 * Fetches authoritative run state via `skill.getRun` (the same call RunDetailPage
 * uses). If the run can't be loaded (e.g. deleted) it degrades to the summary alone
 * rather than rendering a broken card.
 */
export function ConsoleWorkflowResultCard({
  runId,
  workflowName,
  summary,
}: ConsoleWorkflowResultCardProps): ReactElement {
  const navigate = useNavigate();
  const { data, error } = useEntity<Awaited<ReturnType<typeof skill.getRun>> | null>(
    K.run(runId),
    () => skill.getRun(runId)
  );

  const run = error !== null ? null : (data?.run ?? null);

  // Loading or unfetchable → summary only (never a broken/empty card).
  if (run === null) {
    return (
      <div className="rounded-md border border-border bg-surface px-3 py-2 text-[13px] whitespace-pre-wrap text-text-secondary">
        {summary}
      </div>
    );
  }

  const { completed, total } = countTerminalNodes(data?.events ?? []);
  const glyph = RESULT_GLYPH[run.status] ?? '•';
  const label = RESULT_LABEL[run.status] ?? `Workflow ${statusLabel[run.status].toLowerCase()}`;
  const duration = formatElapsed(elapsedSince(run.startedAt, run.finishedAt ?? undefined));
  const cost = run.costUsd !== null ? formatCost(run.costUsd) : null;

  return (
    <div className="rounded-md border border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-[12px]">
        <span aria-hidden className={`shrink-0 ${statusTextClass[run.status]}`}>
          {glyph}
        </span>
        <span className={`min-w-0 flex-1 truncate font-medium ${statusTextClass[run.status]}`}>
          {label}: <span className="text-text-primary">{workflowName}</span>
        </span>
        {total > 0 ? (
          <span className="shrink-0 font-mono text-[11px] text-text-tertiary">
            {completed}/{total} nodes
          </span>
        ) : null}
        <span className="shrink-0 font-mono text-[11px] text-text-tertiary">{duration}</span>
        {cost !== null ? (
          <span className="shrink-0 rounded-full bg-surface-hover px-2 py-0.5 font-mono text-[10px] text-text-tertiary">
            {cost}
          </span>
        ) : null}
        {run.projectId !== null ? (
          <button
            type="button"
            onClick={(): void => {
              void navigate(`/console/p/${run.projectId}/r/${runId}`);
            }}
            className="shrink-0 text-[11px] text-text-secondary transition-colors hover:text-text-primary"
          >
            Open run →
          </button>
        ) : null}
      </div>
      {summary.trim().length > 0 ? (
        <div className="px-3 py-2 text-[13px] whitespace-pre-wrap text-text-secondary">
          {summary}
        </div>
      ) : null}
    </div>
  );
}
