import type { ReactElement } from 'react';
import { Link } from 'react-router';
import { StatusStrip } from './StatusStrip';
import { OriginBadge } from './OriginBadge';
import { ApprovalContext } from './ApprovalContext';
import { RunActionBar } from './RunActionBar';
import { AttentionAnswerPanel } from './AttentionAnswerPanel';
import { ApprovalPanel } from './ApprovalPanel';
import type { Run } from '../primitives/run';
import { shortRunId, formatElapsed, elapsedSince } from '../lib/format';
import { runStatusLabel } from '../lib/run-status';

interface PendingInputBannerProps {
  /** Paused runs awaiting user input, already filtered to non-dismissed. */
  runs: Run[];
  /** Show the project name on each card (true on the All-projects view). */
  showProject: boolean;
  onDismiss: (runId: string) => void;
}

/**
 * Pinned above the feed regardless of its filters and pagination. While promoted
 * here, a run's feed card collapses its action panel to avoid duplicate forms.
 * Dismissal lasts only for this occurrence in the current browser session.
 *
 * The banner scrolls inside a bounded height: a card is several hundred pixels
 * tall, so an unbounded list pushes the feed and the draft card off screen.
 */
export function PendingInputBanner({
  runs,
  showProject,
  onDismiss,
}: PendingInputBannerProps): ReactElement | null {
  if (runs.length === 0) return null;

  return (
    <div className="flex max-h-[45%] shrink-0 flex-col border-b border-warning/25 bg-warning/[0.04] py-3">
      <div className="mb-2 flex shrink-0 items-center gap-2 px-6">
        <span aria-hidden className="text-console-13 leading-none text-warning">
          ⚠
        </span>
        <span className="text-console-10 font-semibold uppercase tracking-console-display text-warning">
          Needs your input
        </span>
        <span className="font-mono text-console-11 tabular-nums text-warning/70">
          {runs.length}
        </span>
      </div>
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto px-6">
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
      className="relative shrink-0 overflow-hidden rounded border border-warning/40 bg-surface"
    >
      <StatusStrip status="paused" />
      <div className="py-3 pl-4 pr-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span
            aria-hidden
            className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-warning"
          />
          <span className="shrink-0 text-console-10 font-semibold uppercase tracking-console-label text-warning">
            {runStatusLabel(run)}
          </span>
          <span className="mx-1 h-3 w-px shrink-0 bg-border" aria-hidden />
          <span className="text-sm font-medium text-text-primary">{run.workflow}</span>
          <span className="font-mono text-console-11 text-text-tertiary">{shortRunId(run.id)}</span>
          {showProject && run.projectName !== null ? (
            <span className="truncate text-console-11 text-text-secondary">
              · {run.projectName}
            </span>
          ) : null}
          <div className="ml-auto flex items-center gap-3">
            <OriginBadge origin={run.origin} />
            <span className="font-mono text-console-11 tabular-nums text-text-tertiary">
              {elapsed}
            </span>
            <button
              type="button"
              onClick={() => {
                onDismiss(run.id);
              }}
              title="Hide until next load — the run stays paused"
              className="rounded border border-border px-2 py-0.5 text-console-11 text-text-tertiary transition-colors hover:border-border-bright hover:bg-surface-hover hover:text-text-primary"
            >
              Dismiss
            </button>
          </div>
        </div>

        {/* Several runs of one workflow ask the same question; the input tells them apart. */}
        {run.userMessage !== '' ? (
          <div className="mt-2 flex min-w-0 items-baseline gap-2 text-console-12">
            <span className="shrink-0 font-mono text-text-tertiary">input</span>
            <span className="truncate font-mono text-text-secondary" title={run.userMessage}>
              {run.userMessage}
            </span>
          </div>
        ) : null}

        {run.attention?.kind === 'attention' ? (
          <>
            <p className="mt-3 whitespace-pre-wrap text-sm text-text-primary">
              {run.attention.message}
            </p>
            <AttentionAnswerPanel run={run} attention={run.attention} />
            <RunActionBar run={run} />
          </>
        ) : run.attention?.kind === 'usage_limit' ? (
          <>
            <p className="mt-3 text-sm text-text-primary">
              Node <span className="font-mono">{run.attention.nodeId}</span> hit a provider usage or
              rate limit. The run continues by itself at{' '}
              {new Date(run.attention.resumeAt).toLocaleString()}.
            </p>
            <RunActionBar run={run} />
          </>
        ) : run.attention?.kind === 'unreadable' ? (
          <div className="mt-3 text-sm text-error">
            <p>Repair needed: {run.attention.detail}</p>
            <Link className="underline" to={`/console/r/${run.id}`}>
              Inspect run
            </Link>
          </div>
        ) : (
          <>
            <ApprovalContext run={run} />
            <ApprovalPanel run={run} />
          </>
        )}
      </div>
    </article>
  );
}
