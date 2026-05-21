import type { ReactElement } from 'react';
import { useNavigate } from 'react-router';
import { OriginBadge } from './OriginBadge';
import type { Run } from '../primitives/run';
import { shortRunId, formatElapsed, elapsedSince, formatCost } from '../lib/format';
import { statusTextClass } from '../lib/run-status';

interface RecentRunRowProps {
  run: Run;
  showProject?: boolean;
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
export function RecentRunRow({ run, showProject = false }: RecentRunRowProps): ReactElement {
  const navigate = useNavigate();
  const elapsed = formatElapsed(elapsedSince(run.startedAt, run.finishedAt ?? undefined));
  const canOpen = run.projectId !== null && !run.id.startsWith('demo-');
  const glyph = STATUS_GLYPH[run.status] ?? '·';

  const onClick = (): void => {
    if (canOpen) navigate(`/console/p/${run.projectId}/r/${run.id}`);
  };

  return (
    <div
      onClick={onClick}
      role={canOpen ? 'button' : undefined}
      className={`group flex h-9 items-center gap-3 border-b border-border/40 px-3 font-mono text-[12px] transition-colors hover:bg-surface-hover ${
        canOpen ? 'cursor-pointer' : ''
      }`}
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
      <span
        aria-hidden
        className="w-3 shrink-0 text-text-tertiary opacity-0 transition-opacity group-hover:opacity-100"
      >
        →
      </span>
    </div>
  );
}
