import { useEffect, type ReactElement } from 'react';
import { useNavigate } from 'react-router';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import * as skill from '../skills';
import { countTerminalNodes } from '../primitives/event';
import type { RunStatus } from '../lib/run-status';
import { statusTextClass, statusLabel } from '../lib/run-status';
import { formatElapsed, elapsedSince, formatCost } from '../lib/format';

interface ConsoleWorkflowResultCardProps {
  runId: string;
  workflowName: string;
  /** The orchestrator's summary prose (the message content). Rendered as the body. */
  summary: string;
}

// Only terminal statuses get a dedicated glyph/label — this is a *completion* card.
// A still-`running`/`paused` run reaches here only in a brief race (the card mounts
// before getRun reflects completion); those fall back to the generic glyph + label.
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

/**
 * A formatted card for a `workflow_result` chat message: status + node counts +
 * duration + cost + a link to the run detail, with the summary prose as the body.
 * Fetches authoritative run state via `skill.getRun` (the same call RunDetailPage
 * uses). While the run is still loading, or if it can't be loaded at all (deleted,
 * or a fetch error), it degrades to the summary prose alone rather than rendering a
 * broken card.
 */
export function ConsoleWorkflowResultCard({
  runId,
  workflowName,
  summary,
}: ConsoleWorkflowResultCardProps): ReactElement {
  const navigate = useNavigate();
  const { data, error } = useEntity<Awaited<ReturnType<typeof skill.getRun>>>(K.run(runId), () =>
    skill.getRun(runId)
  );

  // useEntity surfaces a fetch failure as `error` (Error | undefined). Don't let it
  // vanish silently — the card already falls back to the summary, but a transient
  // 500 looks identical to a deleted run without this breadcrumb.
  useEffect(() => {
    if (error !== undefined) {
      console.warn('[console] workflow result card: getRun failed, showing summary only', {
        runId,
        message: error.message,
      });
    }
  }, [error, runId]);

  // `error` is `Error | undefined` (never null) — compare against undefined, else
  // the rich card never renders. Loading (data undefined) and error both → summary.
  const run = error !== undefined ? null : (data?.run ?? null);

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
