import type { ReactElement } from 'react';
import { useNavigate } from 'react-router';
import { OriginBadge } from './OriginBadge';
import type { Run } from '../primitives/run';
import { shortRunId, formatElapsed, elapsedSince, formatCost } from '../lib/format';
import { useIsDocker, openInIde } from '../lib/health';
import { statusTextClass } from '../lib/run-status';

interface RecentRunRowProps {
  run: Run;
  showProject?: boolean;
  selected?: boolean;
}

const STATUS_GLYPH: Record<string, string> = {
  completed: '●',
  failed: '✕',
  cancelled: '◌',
};

/**
 * Compact one-liner row for terminal-state runs (completed / failed /
 * cancelled). ~36px tall, monospace, data-heavy. Scans like a log.
 *
 * Failed rows keep the error-red glyph and status text so they still catch
 * the eye in a sea of muted completed rows.
 */
export function RecentRunRow({
  run,
  showProject = false,
  selected = false,
}: RecentRunRowProps): ReactElement {
  const navigate = useNavigate();
  const isDocker = useIsDocker();
  const elapsed = formatElapsed(elapsedSince(run.startedAt, run.finishedAt ?? undefined));
  const canOpen = run.projectId !== null && !run.id.startsWith('demo-');
  const canOpenIde =
    !isDocker && run.workingPath !== null && run.workingPath !== '' && !run.id.startsWith('demo-');
  const canRerun =
    run.projectId !== null &&
    run.workflow !== '' &&
    !run.id.startsWith('demo-') &&
    (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled');
  const glyph = STATUS_GLYPH[run.status] ?? '·';

  const onClick = (): void => {
    if (canOpen) navigate(`/console/p/${run.projectId}/r/${run.id}`);
  };

  const onRerun = (): void => {
    if (!canRerun || run.projectId === null) return;
    const params = new URLSearchParams({
      rerun: '1',
      workflow: run.workflow,
    });
    if (run.userMessage.length > 0) params.set('message', run.userMessage);
    navigate(`/console/p/${run.projectId}?${params.toString()}`);
  };

  return (
    <div
      data-run-id={run.id}
      onClick={onClick}
      role={canOpen ? 'button' : undefined}
      className={`group flex h-9 items-center gap-3 border-b border-border/40 px-3 font-mono text-[12px] transition-colors hover:bg-surface-hover ${
        selected ? 'bg-surface-hover ring-2 ring-inset ring-accent-bright/40' : ''
      } ${canOpen ? 'cursor-pointer' : ''}`}
    >
      <span aria-hidden className={`w-3 shrink-0 text-center ${statusTextClass[run.status]}`}>
        {glyph}
      </span>
      <span
        className={`w-20 shrink-0 text-[11px] uppercase tracking-wider ${statusTextClass[run.status]}`}
      >
        {run.status}
      </span>
      <span className="min-w-0 flex-1 truncate text-text-primary">{run.workflow}</span>
      {showProject && run.projectName !== null ? (
        <span className="hidden w-40 shrink-0 truncate text-text-secondary md:inline">
          {run.projectName}
        </span>
      ) : null}
      <span className="hidden w-24 shrink-0 truncate text-text-tertiary md:inline">
        {shortRunId(run.id)}
      </span>
      <span className="w-20 shrink-0 text-right tabular-nums text-text-tertiary">{elapsed}</span>
      <span
        className="hidden w-16 shrink-0 text-right tabular-nums text-text-secondary md:inline"
        title={typeof run.costUsd === 'number' ? 'Total agent cost' : undefined}
      >
        {typeof run.costUsd === 'number' ? formatCost(run.costUsd) : ''}
      </span>
      <OriginBadge origin={run.origin} />
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        {canRerun ? (
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              onRerun();
            }}
            title={`Rerun ${run.workflow} with the same message`}
            aria-label="Rerun"
            className="rounded p-1 text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-primary"
          >
            <span aria-hidden className="text-[12px] leading-none">
              ↻
            </span>
          </button>
        ) : null}
        {canOpenIde && run.workingPath !== null ? (
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              if (run.workingPath !== null) openInIde(run.workingPath);
            }}
            title={`Open ${run.workingPath} in IDE`}
            aria-label="Open in IDE"
            className="rounded p-1 text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-primary"
          >
            <span aria-hidden className="font-mono text-[12px] leading-none">
              ↗
            </span>
          </button>
        ) : null}
        <span aria-hidden className="w-3 text-text-tertiary">
          →
        </span>
      </div>
    </div>
  );
}
