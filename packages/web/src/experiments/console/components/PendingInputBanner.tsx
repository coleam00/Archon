import { useState, type ReactElement } from 'react';
import { Link } from 'react-router';
import { StatusStrip } from './StatusStrip';
import { OriginBadge } from './OriginBadge';
import { ApprovalContext } from './ApprovalContext';
import { RunActionBar } from './RunActionBar';
import { AttentionAnswerPanel } from './AttentionAnswerPanel';
import { ApprovalPanel } from './ApprovalPanel';
import { ItemAsksSection, type ItemAsks } from './ItemAsksSection';
import * as skill from '../skills';
import { HttpError } from '../lib/http';
import { invalidate } from '../store/cache';
import { runDetailPath, type OwnerLostHolder, type Run } from '../primitives/run';
import { shortRunId, formatElapsed, elapsedSince } from '../lib/format';
import { runStatusLabel } from '../lib/run-status';

interface PendingInputBannerProps {
  /** Paused runs awaiting user input, already filtered to non-dismissed. */
  runs: Run[];
  /** Runs holding their item while their owner is gone; only resume or abandon moves them. */
  ownerLost?: OwnerLostHolder[];
  /** Show the project name on each card (true on the All-projects view). */
  showProject: boolean;
  onDismiss: (runId: string) => void;
  /** Asks completed runs left on items; they have no run card of their own. */
  itemAsks: ItemAsks;
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
  ownerLost = [],
  showProject,
  onDismiss,
  itemAsks,
}: PendingInputBannerProps): ReactElement | null {
  if (
    runs.length === 0 &&
    ownerLost.length === 0 &&
    itemAsks.asks.length === 0 &&
    itemAsks.answered.length === 0
  )
    return null;

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
          {runs.length + ownerLost.length + itemAsks.asks.length}
        </span>
      </div>
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto px-6">
        <PendingInputList
          runs={runs}
          ownerLost={ownerLost}
          showProject={showProject}
          onDismiss={onDismiss}
          itemAsks={itemAsks}
        />
      </div>
    </div>
  );
}

/** Everything that waits on the operator, one card each: the banner's list and the Needs you page. */
export function PendingInputList({
  runs,
  ownerLost = [],
  showProject,
  onDismiss,
  itemAsks,
}: PendingInputBannerProps): ReactElement {
  return (
    <>
      {ownerLost.map(holder => (
        <OwnerLostCard key={holder.runId} holder={holder} showProject={showProject} />
      ))}
      {runs.map(run => (
        <PendingInputCard key={run.id} run={run} showProject={showProject} onDismiss={onDismiss} />
      ))}
      <ItemAsksSection {...itemAsks} showProject={showProject} />
    </>
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

/**
 * A run whose owner is gone. The engine never ends it by itself: the operator resumes it,
 * or abandons it so what it holds is free. A pending start no process runs is started once
 * with `archon trigger execute`, which this card names rather than runs.
 */
function OwnerLostCard({
  holder,
  showProject,
}: {
  holder: OwnerLostHolder;
  showProject: boolean;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (action: 'resume' | 'abandon'): Promise<void> => {
    if (
      action === 'abandon' &&
      !globalThis.confirm(
        `Abandon the ${holder.workflow} run? It is cancelled and cannot be resumed.`
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      if (action === 'resume') await skill.resumeRun(holder.runId);
      else await skill.abandonRun(holder.runId);
      invalidate('runs');
    } catch (e: unknown) {
      setError(
        e instanceof HttpError && e.serverError !== undefined
          ? e.serverError
          : e instanceof Error
            ? e.message
            : 'Action failed.'
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <article
      data-owner-lost-run-id={holder.runId}
      className="relative shrink-0 overflow-hidden rounded border border-error/40 bg-surface"
    >
      <StatusStrip status="failed" />
      <div className="py-3 pl-4 pr-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="shrink-0 text-console-10 font-semibold uppercase tracking-console-label text-error">
            Owner gone
          </span>
          <span className="mx-1 h-3 w-px shrink-0 bg-border" aria-hidden />
          <span className="text-sm font-medium text-text-primary">{holder.workflow}</span>
          <Link
            className="font-mono text-console-11 text-text-tertiary underline"
            to={runDetailPath({ id: holder.runId, projectId: holder.projectId })}
          >
            {shortRunId(holder.runId)}
          </Link>
          {showProject && holder.projectName !== null ? (
            <span className="truncate text-console-11 text-text-secondary">
              · {holder.projectName}
            </span>
          ) : null}
        </div>
        <p className="mt-3 text-sm text-text-primary">
          {holder.start === null
            ? `${holder.observedStatus} but its owner is gone`
            : 'admitted but not started, and no process runs it'}
          {holder.itemKey === null ? '' : ', holding item '}
          {holder.itemKey === null ? null : <span className="font-mono">{holder.itemKey}</span>}
          {holder.start === null ? null : (
            <>
              . Start it with{' '}
              <span className="font-mono">
                archon trigger execute {holder.start.requestId} --host {holder.start.hostId}
              </span>
            </>
          )}
          .
        </p>
        <div className="mt-3 flex items-center gap-2">
          {holder.start === null ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act('resume')}
              className="rounded border border-border px-3 py-1 text-console-12 text-text-primary hover:bg-surface-hover disabled:opacity-50"
            >
              Resume
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => void act('abandon')}
            className="rounded border border-error/40 px-3 py-1 text-console-12 text-error hover:bg-error/10 disabled:opacity-50"
          >
            Abandon
          </button>
          {error !== null ? (
            <span role="alert" className="ml-2 font-mono text-console-11 text-error">
              {error}
            </span>
          ) : null}
        </div>
      </div>
    </article>
  );
}
