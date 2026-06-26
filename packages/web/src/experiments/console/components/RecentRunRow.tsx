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
    if (run.userMessage !== '') params.set('message', run.userMessage);
    navigate(`/console/p/${run.projectId}?${params.toString()}`);
  };

  // Design v2 row grid: status | body | (project) | id | duration | cost | CLI.
  const gridCols = showProject
    ? 'grid-cols-[132px_minmax(0,1fr)_140px_84px_70px_64px_auto]'
    : 'grid-cols-[132px_minmax(0,1fr)_84px_70px_64px_auto]';

  return (
    <div
      data-run-id={run.id}
      onClick={onClick}
      role={canOpen ? 'button' : undefined}
      className={`group grid items-center gap-[18px] border-b border-border/40 px-[18px] py-[13px] transition-colors last:border-b-0 hover:bg-surface-hover ${gridCols} ${
        selected ? 'bg-surface-hover ring-2 ring-inset ring-accent-bright/40' : ''
      } ${canOpen ? 'cursor-pointer' : ''}`}
    >
      {/* status: dot/glyph + label */}
      <span className="flex items-center gap-[9px]">
        {run.status === 'failed' ? (
          <span aria-hidden className={`text-[12px] leading-none ${statusTextClass.failed}`}>
            {glyph}
          </span>
        ) : (
          <span
            aria-hidden
            className={`h-2 w-2 shrink-0 rounded-full ${
              run.status === 'completed'
                ? 'bg-success shadow-[0_0_0_3px_color-mix(in_oklch,var(--success),transparent_85%)]'
                : 'bg-text-tertiary'
            }`}
          />
        )}
        <span
          className={`font-mono text-[11px] font-semibold uppercase tracking-[0.05em] ${statusTextClass[run.status]}`}
        >
          {run.status}
        </span>
      </span>

      {/* body: mono workflow name + muted description */}
      <span className="flex min-w-0 items-baseline gap-2.5">
        <span className="shrink-0 truncate font-mono text-[13px] font-bold text-text-primary">
          {run.workflow}
        </span>
        {run.userMessage !== '' ? (
          <span
            className="min-w-0 truncate text-[12.5px] text-text-tertiary"
            title={run.userMessage}
          >
            {run.userMessage}
          </span>
        ) : null}
      </span>

      {showProject ? (
        <span className="truncate text-[12px] text-text-secondary">{run.projectName ?? ''}</span>
      ) : null}

      <span className="text-right font-mono text-[12px] text-text-tertiary">
        {shortRunId(run.id)}
      </span>
      <span className="text-right font-mono text-[12px] tabular-nums text-text-secondary">
        {elapsed}
      </span>
      <span
        className="text-right font-mono text-[12px] tabular-nums text-text-primary"
        title={typeof run.costUsd === 'number' ? 'Total agent cost' : undefined}
      >
        {typeof run.costUsd === 'number' ? formatCost(run.costUsd) : ''}
      </span>

      {/* trailing: origin + hover actions + CLI */}
      <span className="flex items-center justify-end gap-1.5">
        {/* Origin + quick actions reveal on hover; the resting row matches the
            design (status · body · id · duration · cost · CLI). */}
        <span className="flex items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
          <OriginBadge origin={run.origin} />
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
        </span>
        <button
          type="button"
          onClick={e => {
            e.stopPropagation();
            void navigator.clipboard.writeText(`archon workflow get ${run.id}`);
          }}
          title={`Copy CLI command: archon workflow get ${shortRunId(run.id)}`}
          aria-label="Copy CLI command"
          className="inline-flex items-center gap-1.5 rounded-[7px] border bg-surface-elevated px-2.5 py-[5px] font-mono text-[11px] font-semibold text-text-secondary transition-colors hover:border-accent-bright/50 hover:text-text-primary"
          // Inline because the console scope's wildcard border-color rule
          // repaints Tailwind border utilities (see theme.css).
          style={{ borderColor: 'var(--border-bright)' }}
        >
          <span aria-hidden className="text-[10px] leading-none">
            ❯_
          </span>
          CLI
        </button>
      </span>
    </div>
  );
}
