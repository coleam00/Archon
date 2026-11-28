import { ToolCallAttentionSection } from './ToolCallAttentionSection';
import { useState, type ReactElement, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { StatusStrip } from './StatusStrip';
import { RunningDot } from './LiveDot';
import { OwnerObservationHint } from './OwnerObservationHint';
import { OperatorPauseHint } from './OperatorPauseHint';
import { OriginBadge } from './OriginBadge';
import { RelativeRunTime } from './RelativeRunTime';
import { RunStepStrip } from './RunStepStrip';
import { ApprovalPanel } from './ApprovalPanel';
import { AttentionAnswerPanel, isLegacyAttention } from './AttentionAnswerPanel';
import { ApprovalContext } from './ApprovalContext';
import { runDetailPath, type Run } from '../primitives/run';
import { shortRunId, formatClock, formatElapsed, elapsedSince, formatCost } from '../lib/format';
import { useIsDocker, useIdeEnv, openInIde } from '../lib/health';
import { lastActivityLabel, quietMinutes, runQuietMs } from '../lib/run-activity';
import { isRunLive, runElapsedLabel, statusTextClass, runStatusLabel } from '../lib/run-status';
import { useNow } from '../lib/use-now';
import { useRunActions } from '../lib/use-run-actions';
import { RunOutcomeBadge } from './RunOutcomeBadge';
import * as skill from '../skills';
import { invalidate } from '../store/cache';
import { K } from '../store/keys';

/** Present + non-empty — narrows `string | null | undefined` to `string`. */
const hasValue = (v: string | null | undefined): v is string => v != null && v !== '';

function activeNodesLabel(count: number, live: boolean): string {
  const noun = count === 1 ? 'node' : 'nodes';
  return live ? noun : `last recorded ${noun}`;
}

interface ActiveRunCardProps {
  run: Run;
  showProject?: boolean;
  selected?: boolean;
  /**
   * Promoted runs show a pointer instead of duplicating the banner's actions.
   * Dismissing the banner restores the inline controls.
   */
  inputPromoted?: boolean;
  /** Adds the details below the compact card; the runs page sets it for every card at once. */
  expanded?: boolean;
}

type AttentionAction = 'resume' | 'abandon';
type RunWait = NonNullable<Run['wait']>;
type AttentionWait = Extract<NonNullable<Run['attention']>, { kind: 'attention' }>;
type IdeEnv = ReturnType<typeof useIdeEnv>;
type RunProgress = NonNullable<Run['progress']>;

interface AttentionActions {
  busy: AttentionAction | null;
  error: string | null;
  resolve: (action: AttentionAction) => Promise<void>;
}

/** Card-lifetime state for the inline resume/abandon buttons of an attention wait. */
function useAttentionActions(runId: string): AttentionActions {
  const [busy, setBusy] = useState<AttentionAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resolve = async (action: AttentionAction): Promise<void> => {
    setBusy(action);
    setError(null);
    try {
      if (!runId.startsWith('demo-')) {
        if (action === 'resume') await skill.resumeRun(runId);
        else await skill.abandonRun(runId);
      }
      invalidate('runs');
      invalidate(K.run(runId));
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : 'Action failed.');
    } finally {
      setBusy(null);
    }
  };

  return { busy, error, resolve };
}

function cardClassName(isLive: boolean, selected: boolean, canOpen: boolean): string {
  return `group relative overflow-hidden rounded-console-12 border transition-colors hover:bg-surface-hover ${
    isLive ? 'bg-warning/[0.04]' : 'bg-surface'
  } ${selected ? 'ring-2 ring-accent-bright/40' : ''} ${
    canOpen ? 'cursor-pointer focus-visible:outline-none' : ''
  }`;
}

// Inline because the console scope's wildcard border-color rule repaints Tailwind
// border utilities (see theme.css). Running cards get the design's amber tint, and a
// quiet one a stronger amber.
function cardBorderColor(isLive: boolean, selected: boolean, quiet: boolean): string {
  if (selected) return 'color-mix(in oklch, var(--accent-bright), transparent 30%)';
  if (quiet) return 'color-mix(in oklch, var(--warning), transparent 35%)';
  return isLive ? 'color-mix(in oklch, var(--warning), transparent 70%)' : 'var(--border)';
}

function StatusDot({ run, isLive }: { run: Run; isLive: boolean }): ReactElement {
  return run.status === 'running' ? (
    <RunningDot live={isLive} />
  ) : (
    <span aria-hidden className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-warning" />
  );
}

function OpenInIdeButton({
  workingPath,
  ideEnv,
}: {
  workingPath: string;
  ideEnv: IdeEnv;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={e => {
        e.stopPropagation();
        openInIde(workingPath, ideEnv);
      }}
      title={`Open ${workingPath} in IDE`}
      aria-label="Open in IDE"
      className="ml-1 rounded p-1 text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-primary"
    >
      <span aria-hidden className="font-mono text-console-12 leading-none">
        ↗
      </span>
    </button>
  );
}

/**
 * The card's headline: the item the run is on, as its key is recorded, or the run's input
 * when it is on none. The key is opaque, so it is shown and never parsed. An item's title
 * and link, once something records them, fill this same slot.
 */
function ItemSlot({ run }: { run: Run }): ReactElement | null {
  if (hasValue(run.itemKey)) {
    return (
      <span className="min-w-0 truncate font-mono text-sm font-semibold text-text-primary">
        {run.itemKey}
      </span>
    );
  }
  return run.userMessage !== '' ? (
    <span
      className="min-w-0 truncate text-sm font-medium text-text-primary"
      title={run.userMessage}
    >
      {run.userMessage}
    </span>
  ) : null;
}

/** The first line of the run's last agent message that says anything. */
function doingLine(run: Run): string | null {
  const text = run.progress?.last_message?.text;
  if (text == null) return null;
  return (
    text
      .split('\n')
      .map(line => line.trim())
      .find(line => line !== '') ?? null
  );
}

/** Elapsed time, and for a running run how recently it recorded anything. */
function RunClock({
  run,
  now,
  quietMs,
}: {
  run: Run;
  now: number;
  quietMs: number | null;
}): ReactElement {
  const lastObservedAt = run.status === 'running' ? run.progress?.last_observed_at : null;
  return (
    <div className="ml-auto shrink-0 text-right font-mono text-console-11 tabular-nums">
      <div className="text-sm font-semibold text-text-primary">
        {runElapsedLabel(run, formatElapsed(elapsedSince(run.startedAt)))}
      </div>
      {quietMs !== null ? (
        <div className="text-warning">{`quiet ${quietMinutes(quietMs).toString()}m`}</div>
      ) : lastObservedAt != null ? (
        <div className="text-text-tertiary">{lastActivityLabel(lastObservedAt, now)}</div>
      ) : null}
    </div>
  );
}

/**
 * What every card shows: the item, the workflow and where it is, what the agent last
 * said, the step strip, and the time.
 */
function RunCardSummary({
  run,
  showProject,
  isLive,
  expanded,
  now,
  quietMs,
}: {
  run: Run;
  showProject: boolean;
  isLive: boolean;
  expanded: boolean;
  now: number;
  quietMs: number | null;
}): ReactElement {
  const doing = doingLine(run);
  return (
    <>
      <div className="flex items-start gap-3">
        <span className="mt-1.5 shrink-0">
          <StatusDot run={run} isLive={isLive} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <ItemSlot run={run} />
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-console-12">
            <span className="rounded-full bg-accent-bright/15 px-2 py-px font-mono text-console-11 text-text-primary">
              {run.workflow}
            </span>
            <span
              className={`shrink-0 text-console-10 font-semibold uppercase tracking-console-label ${statusTextClass[run.status]}`}
            >
              {runStatusLabel(run)}
            </span>
            <RunOutcomeBadge outcome={run.outcome} />
            {run.status === 'running' && run.activeNodes.length > 0 ? (
              <span className="min-w-0 truncate font-mono">
                <span className="text-text-tertiary">
                  {activeNodesLabel(run.activeNodes.length, isLive)}
                </span>{' '}
                <span className="font-semibold text-text-primary">
                  {run.activeNodes.join(', ')}
                </span>
              </span>
            ) : null}
            {showProject && run.projectName !== null ? (
              <span className="truncate text-console-11 text-text-secondary">
                · {run.projectName}
              </span>
            ) : null}
          </div>
          {doing !== null ? (
            <div className="truncate text-console-12 text-text-secondary">{doing}</div>
          ) : null}
        </div>
        <RunClock run={run} now={now} quietMs={quietMs} />
      </div>
      {run.progress != null ? (
        <RunStepStrip steps={run.progress.steps} named={expanded} live={isLive} />
      ) : null}
    </>
  );
}

function LastMessage({ progress }: { progress: RunProgress }): ReactElement {
  const message = progress.last_message;
  return (
    <div
      className="mt-2 rounded border bg-surface-inset px-3 py-2 text-console-12"
      style={{ borderColor: 'var(--border)' }}
    >
      {message === null ? (
        <span className="text-text-tertiary">no message yet</span>
      ) : (
        <>
          <div className="line-clamp-3 whitespace-pre-line text-text-primary">
            {message.text}
            {message.truncated === true ? '…' : ''}
          </div>
          <div className="mt-1 font-mono text-console-11 text-text-tertiary">
            last message · {message.node_id} · {formatClock(message.at)}
          </div>
        </>
      )}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-px">
      <span className="text-console-10 font-semibold uppercase tracking-console-label text-text-tertiary">
        {label}
      </span>
      <span className="min-w-0 break-all font-mono text-console-11 text-text-secondary">
        {children}
      </span>
    </div>
  );
}

/** The models the run's running steps asked for; empty when none recorded one. */
function runningModels(progress: RunProgress | null): string[] {
  const models = (progress?.steps ?? []).flatMap(step =>
    step.state === 'running' && step.model !== undefined ? [step.model] : []
  );
  return [...new Set(models)];
}

const ACTION_CLASS =
  'rounded-md border bg-surface px-2.5 py-1 text-console-11 font-semibold transition-colors disabled:opacity-50';

/** Log and Cancel. Cancel asks first and reports a refusal exactly as the run page does. */
function RunCardActions({ run }: { run: Run }): ReactElement {
  const { busy, error, call } = useRunActions(run);
  return (
    <div className="ml-auto flex flex-wrap items-center gap-2">
      {error !== null ? (
        <span className="whitespace-pre-line font-mono text-console-11 text-error">{error}</span>
      ) : null}
      {run.id.startsWith('demo-') ? null : (
        <Link
          to={runDetailPath(run)}
          onClick={event => {
            event.stopPropagation();
          }}
          className={`${ACTION_CLASS} text-text-primary hover:bg-surface-hover`}
          style={{ borderColor: 'var(--border-bright)' }}
        >
          Log
        </Link>
      )}
      {run.status === 'running' ? (
        <button
          type="button"
          onClick={event => {
            event.stopPropagation();
            void call('cancel');
          }}
          disabled={busy !== null}
          className={`${ACTION_CLASS} text-error hover:bg-error/10`}
          style={{ borderColor: 'var(--border-bright)' }}
        >
          {busy === 'cancel' ? 'Cancelling…' : 'Cancel'}
        </button>
      ) : null}
    </div>
  );
}

function LinkedRun({
  run,
  runId,
  relation,
}: {
  run: Run;
  runId: string;
  relation: string;
}): ReactElement {
  return (
    <Link
      to={runDetailPath({ id: runId, projectId: run.projectId })}
      onClick={event => {
        event.stopPropagation();
      }}
      title={runId}
      className="mr-2 underline hover:text-text-primary"
    >
      {relation} {shortRunId(runId)}
    </Link>
  );
}

/** Where to find the run elsewhere: its id, nodes, worktree, base branch and linked runs. */
function RunInternals({ run, isLive }: { run: Run; isLive: boolean }): ReactElement {
  const isDocker = useIsDocker();
  const ideEnv = useIdeEnv();
  const ideWorkingPath =
    !isDocker && hasValue(run.workingPath) && !run.id.startsWith('demo-') ? run.workingPath : null;
  const baseBranch = run.progress?.base_branch;
  return (
    <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2 rounded bg-surface-inset px-3 py-2">
      <Fact label="Run">
        <span title={run.id}>{shortRunId(run.id)}</span> · {run.workflow}
      </Fact>
      {run.activeNodes.length > 0 ? (
        <Fact label={`Active ${activeNodesLabel(run.activeNodes.length, isLive)}`}>
          {run.activeNodes.join(', ')}
        </Fact>
      ) : null}
      {hasValue(run.workingPath) ? (
        <Fact label="Worktree">
          {run.workingPath}
          {ideWorkingPath !== null ? (
            <OpenInIdeButton workingPath={ideWorkingPath} ideEnv={ideEnv} />
          ) : null}
        </Fact>
      ) : null}
      {hasValue(baseBranch) ? <Fact label="Base branch">{baseBranch}</Fact> : null}
      {hasValue(run.parentRunId) || hasValue(run.adoptedFromRunId) ? (
        <Fact label="Linked runs">
          {hasValue(run.parentRunId) ? (
            <LinkedRun run={run} runId={run.parentRunId} relation="child of" />
          ) : null}
          {hasValue(run.adoptedFromRunId) ? (
            <LinkedRun run={run} runId={run.adoptedFromRunId} relation="continues" />
          ) : null}
        </Fact>
      ) : null}
    </div>
  );
}

/** The run's branch, or the base it works from when it has no branch of its own. */
function branchLabel(progress: RunProgress | null): string | null {
  if (hasValue(progress?.branch)) return progress.branch;
  return hasValue(progress?.base_branch) ? `from ${progress.base_branch}` : null;
}

/**
 * What "Show details" adds: the last agent message, where the run works, what it costs,
 * where it was started, its actions and its internals. Each fact renders only when the
 * run recorded it.
 */
function RunCardDetails({
  run,
  isLive,
  quietMs,
}: {
  run: Run;
  isLive: boolean;
  quietMs: number | null;
}): ReactElement {
  const progress = run.progress ?? null;
  const models = runningModels(progress);
  const branch = branchLabel(progress);
  return (
    <div className="mt-2">
      {progress !== null ? <LastMessage progress={progress} /> : null}
      {quietMs !== null ? (
        <p className="mt-2 text-console-12 text-warning">
          No activity for {quietMinutes(quietMs)}m. Check the{' '}
          <Link
            to={runDetailPath(run)}
            onClick={event => {
              event.stopPropagation();
            }}
            className="underline"
          >
            log
          </Link>
          .
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-console-11 text-text-secondary">
        {branch !== null ? <span title="Branch">{branch}</span> : null}
        {models.length > 0 ? <span title="Model">{models.join(', ')}</span> : null}
        {typeof run.costUsd === 'number' ? (
          <span className="tabular-nums" title="Reported agent cost; may be partial">
            {`Reported cost ${formatCost(run.costUsd)} (may be partial)`}
          </span>
        ) : null}
        <span className="flex items-center gap-1.5">
          {run.origin !== 'unknown' ? <OriginBadge origin={run.origin} /> : null}
          <RelativeRunTime
            className="whitespace-nowrap text-text-tertiary"
            at={run.startedAt}
            verb="Started"
          />
        </span>
        <RunCardActions run={run} />
      </div>
      {hasValue(run.itemKey) && run.userMessage !== '' ? (
        <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 text-console-12">
          <span className="font-mono text-text-tertiary">input</span>
          <span className="truncate font-mono text-text-secondary" title={run.userMessage}>
            {run.userMessage}
          </span>
        </div>
      ) : null}
      <RunInternals run={run} isLive={isLive} />
    </div>
  );
}

function PromotedWaitPointer({ run }: { run: Run }): ReactElement {
  return (
    <div className="mt-2 rounded border border-warning/25 bg-warning/[0.05] px-3 py-2 text-console-12 text-warning">
      {run.attention?.kind === 'usage_limit'
        ? 'Waiting on a provider limit — see the banner at the top.'
        : 'Waiting for your input — see the banner at the top.'}
    </div>
  );
}

function AttentionActionButtons({
  attention,
  actions,
}: {
  attention: AttentionWait;
  actions: AttentionActions;
}): ReactElement {
  const { busy, error, resolve } = actions;
  return (
    <span className="flex flex-wrap items-center gap-2">
      {isLegacyAttention(attention) ? (
        <button
          type="button"
          onClick={event => {
            event.stopPropagation();
            void resolve('resume');
          }}
          disabled={busy !== null}
          className="rounded bg-warning/15 px-2 py-1 font-semibold text-warning hover:bg-warning/25 disabled:opacity-50"
        >
          {busy === 'resume' ? 'Resuming…' : 'Resume'}
        </button>
      ) : null}
      <button
        type="button"
        onClick={event => {
          event.stopPropagation();
          void resolve('abandon');
        }}
        disabled={busy !== null}
        className="rounded px-2 py-1 text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
      >
        {busy === 'abandon' ? 'Abandoning…' : 'Abandon'}
      </button>
      {error !== null ? <span className="font-mono text-error">{error}</span> : null}
    </span>
  );
}

function AttentionRows({
  run,
  attention,
  actions,
}: {
  run: Run;
  attention: AttentionWait;
  actions: AttentionActions;
}): ReactElement {
  return (
    <>
      <span className="font-mono text-text-tertiary">needs</span>
      <span className="text-text-secondary">{attention.message}</span>
      <span className="font-mono text-text-tertiary">answer</span>
      <span className="flex flex-col gap-1">
        <AttentionAnswerPanel run={run} attention={attention} />
        <AttentionActionButtons attention={attention} actions={actions} />
      </span>
    </>
  );
}

function WaitResumeRow({ wait }: { wait: Exclude<RunWait, { kind: 'attention' }> }): ReactElement {
  return (
    <>
      <span className="font-mono text-text-tertiary">
        {wait.kind === 'event' ? 'deadline' : 'resume'}
      </span>
      <span className="font-mono text-text-secondary">
        {new Date(wait.resumeAt).toLocaleString()}
      </span>
    </>
  );
}

function WaitPanel({
  run,
  wait,
  actions,
}: {
  run: Run;
  wait: RunWait;
  actions: AttentionActions;
}): ReactElement {
  return (
    <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded border border-warning/25 bg-warning/[0.05] px-3 py-2 text-console-12">
      <span className="font-mono text-text-tertiary">node</span>
      <span className="font-mono text-text-primary">{wait.nodeId}</span>
      {wait.kind === 'event' && wait.event !== undefined ? (
        <>
          <span className="font-mono text-text-tertiary">event</span>
          <span className="font-mono text-text-primary">{wait.event}</span>
        </>
      ) : null}
      {run.attention?.kind === 'attention' ? (
        <AttentionRows run={run} attention={run.attention} actions={actions} />
      ) : wait.kind !== 'attention' ? (
        <WaitResumeRow wait={wait} />
      ) : null}
    </div>
  );
}

/**
 * Resolved gate awaiting auto-resume — the run is still 'paused' in the DB for the
 * second or so between approve/reject and the executor flipping it to running. Shows
 * a hint instead of stale gate buttons.
 */
function GateResolvedHint({
  gateResolved,
}: {
  gateResolved: NonNullable<Run['gateResolved']>;
}): ReactElement {
  return (
    <div className="mt-2 flex items-center gap-2 rounded border border-border bg-surface-hover/40 px-3 py-2 text-console-12 text-text-secondary">
      <span aria-hidden className="inline-block animate-pulse leading-none">
        ▸
      </span>
      <span>
        {gateResolved === 'approved'
          ? 'Approved — resuming…'
          : 'Rejected — running on-reject rework…'}
      </span>
    </div>
  );
}

/** Paused-run surfaces: the wait cursor, the approval gate, or the resolved-gate hint. */
function PausedRunSection({
  run,
  inputPromoted,
  actions,
}: {
  run: Run;
  inputPromoted: boolean;
  actions: AttentionActions;
}): ReactElement {
  const paused = run.status === 'paused';
  return (
    <>
      {paused && inputPromoted ? <PromotedWaitPointer run={run} /> : null}
      {paused && !inputPromoted && run.wait != null ? (
        <WaitPanel run={run} wait={run.wait} actions={actions} />
      ) : null}
      {/* The context block shows the actual question the agent asked (pulled from the
          last text event), because the approval node's own `message` is usually just a
          pointer ("answer the questions above"). */}
      {!inputPromoted && run.attention?.kind === 'awaiting_response' ? (
        <>
          <ApprovalContext run={run} />
          <ApprovalPanel run={run} />
        </>
      ) : null}
      {paused && run.gateResolved != null ? (
        <GateResolvedHint gateResolved={run.gateResolved} />
      ) : null}
    </>
  );
}

/**
 * Card for `running` and `paused` runs. Compact by default: the item, the workflow and
 * where it is, what the agent last said, a step strip, and the time. `expanded` adds the
 * details an operator otherwise opens the run for.
 *
 * Running:
 *   - Pulsing blue live dot; the status strip and the running step pulse
 *   - "active Nm ago", or a "quiet Nm" warning once the run has recorded nothing for
 *     `QUIET_AFTER_MS` (`runQuietMs` names the runs that are never flagged)
 *   - All of that only while live: once the server reports the owner unreachable or
 *     unknown, the dot, strip and tint go still, the time reads as since launch, the
 *     nodes as last recorded, and a hint says why
 *
 * Paused:
 *   - Amber pulsing dot
 *   - Inline ApprovalPanel with context input + Approve/Reject (unless the
 *     approval is promoted to the banner, in which case a pointer shows)
 *   - User can resolve without leaving the feed
 */
export function ActiveRunCard({
  run,
  showProject = false,
  selected = false,
  inputPromoted = false,
  expanded = false,
}: ActiveRunCardProps): ReactElement {
  const navigate = useNavigate();
  const attentionActions = useAttentionActions(run.id);
  const now = useNow(30_000);
  const isLive = isRunLive(run);
  const quietMs = runQuietMs(run, now);
  const canOpen = !run.id.startsWith('demo-');

  const onCardClick = (): void => {
    if (canOpen) navigate(runDetailPath(run));
  };

  return (
    <article
      data-run-id={run.id}
      onClick={onCardClick}
      role={canOpen ? 'button' : undefined}
      tabIndex={canOpen ? 0 : undefined}
      onKeyDown={
        canOpen
          ? (e): void => {
              if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                onCardClick();
              }
            }
          : undefined
      }
      className={cardClassName(isLive, selected, canOpen)}
      style={{ borderColor: cardBorderColor(isLive, selected, quietMs !== null) }}
    >
      <StatusStrip status={run.status} live={isLive} />
      <div className="pl-4 pr-4 py-3">
        <RunCardSummary
          run={run}
          showProject={showProject}
          isLive={isLive}
          expanded={expanded}
          now={now}
          quietMs={quietMs}
        />
        <OwnerObservationHint run={run} className="mt-1" />
        <OperatorPauseHint run={run} className="mt-1" />
        <ToolCallAttentionSection run={run} />
        <PausedRunSection run={run} inputPromoted={inputPromoted} actions={attentionActions} />
        {expanded ? <RunCardDetails run={run} isLive={isLive} quietMs={quietMs} /> : null}
      </div>
    </article>
  );
}
