import type { ReactElement } from 'react';
import { StatusStrip } from './StatusStrip';
import { OriginBadge } from './OriginBadge';
import { ApprovalContext } from './ApprovalContext';
import { ApprovalPanel } from './ApprovalPanel';
import type { Run } from '../primitives/run';
import { shortRunId, formatElapsed, elapsedSince } from '../lib/format';
import { statusLabel } from '../lib/run-status';

interface PendingInputBannerProps {
  /** Paused runs awaiting user input, already filtered to non-dismissed. */
  runs: Run[];
  /** Show the project name on each card (true on the All-projects view). */
  showProject: boolean;
  onDismiss: (runId: string) => void;
}

/**
 * Attention surface for runs paused on a human gate (approval node or a
 * question the agent asked). Pinned above the runs feed so a run that needs
 * action can't be missed — it stays visible regardless of the active filter
 * or how far the feed is scrolled, until the user acts on it or dismisses it.
 *
 * The action surface is the same {@link ApprovalContext} + {@link ApprovalPanel}
 * used inline on a paused card; while a run is surfaced here its feed card
 * collapses to a pointer so the live panel isn't duplicated.
 *
 * Dismiss is session-only — the run is still paused, so it re-surfaces on the
 * next load. Acting on it later happens from the feed card (which restores the
 * inline panel once dismissed).
 */
export function PendingInputBanner({
  runs,
  showProject,
  onDismiss,
}: PendingInputBannerProps): ReactElement | null {
  if (runs.length === 0) return null;

  return (
    <div className="shrink-0 border-b border-warning/25 bg-warning/[0.04] px-6 py-3">
      <div className="mb-2 flex items-center gap-2">
        <span aria-hidden className="text-[13px] leading-none text-warning">
          ⚠
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-warning">
          Needs your input
        </span>
        <span className="font-mono text-[11px] tabular-nums text-warning/70">{runs.length}</span>
      </div>
      <div className="flex flex-col gap-2">
        {runs.map(run => (
          <PendingInputCard
            key={run.id}
            run={run}
            showProject={showProject}
            onDismiss={onDismiss}
          />
        ))}
      </div>
    </div>
  );
}

interface PendingInputCardProps {
  run: Run;
  showProject: boolean;
  onDismiss: (runId: string) => void;
}

function PendingInputCard({ run, showProject, onDismiss }: PendingInputCardProps): ReactElement {
  const elapsed = formatElapsed(elapsedSince(run.startedAt));

  return (
    <article
      data-pending-run-id={run.id}
      className="relative overflow-hidden rounded border border-warning/40 bg-surface"
    >
      <StatusStrip status="paused" />
      <div className="py-3 pl-4 pr-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span
            aria-hidden
            className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-warning"
          />
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-warning">
            {statusLabel.paused}
          </span>
          <span className="mx-1 h-3 w-px shrink-0 bg-border" aria-hidden />
          <span className="text-sm font-medium text-text-primary">{run.workflow}</span>
          <span className="font-mono text-[11px] text-text-tertiary">{shortRunId(run.id)}</span>
          {showProject && run.projectName !== null ? (
            <span className="truncate text-[11px] text-text-secondary">· {run.projectName}</span>
          ) : null}
          <div className="ml-auto flex items-center gap-3">
            <OriginBadge origin={run.origin} />
            <span className="font-mono text-[11px] tabular-nums text-text-tertiary">{elapsed}</span>
            <button
              type="button"
              onClick={() => {
                onDismiss(run.id);
              }}
              title="Hide until next load — the run stays paused"
              className="rounded border border-border px-2 py-0.5 text-[11px] text-text-tertiary transition-colors hover:border-border-bright hover:bg-surface-hover hover:text-text-primary"
            >
              Dismiss
            </button>
          </div>
        </div>

        {/* Same surfaces as a paused card: the question + the action panel. */}
        <ApprovalContext run={run} />
        <ApprovalPanel run={run} />
      </div>
    </article>
  );
}
