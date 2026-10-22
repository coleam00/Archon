import { ToolCallAttentionSection } from './ToolCallAttentionSection';
import { useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router';
import { StatusStrip } from './StatusStrip';
import { RunningDot } from './LiveDot';
import { OwnerObservationHint } from './OwnerObservationHint';
import { OriginBadge } from './OriginBadge';
import { ApprovalPanel } from './ApprovalPanel';
import { AttentionAnswerPanel, isLegacyAttention } from './AttentionAnswerPanel';
import { ApprovalContext } from './ApprovalContext';
import { runDetailPath, type Run } from '../primitives/run';
import { shortRunId, formatElapsed, elapsedSince, formatCost } from '../lib/format';
import { useIsDocker, useIdeEnv, openInIde } from '../lib/health';
import { isRunLive, runElapsedLabel, statusTextClass, runStatusLabel } from '../lib/run-status';
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

/** The blinking cursor after the last tool name that reads as "still working". */
function ToolCursor({ live }: { live: boolean }): ReactElement | null {
  return live ? (
    <span aria-hidden className="ml-1 inline-block animate-pulse">
      ▏
    </span>
  ) : null;
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
}

type AttentionAction = 'resume' | 'abandon';
type RunWait = NonNullable<Run['wait']>;
type AttentionWait = Extract<NonNullable<Run['attention']>, { kind: 'attention' }>;
type IdeEnv = ReturnType<typeof useIdeEnv>;

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
  return `group relative overflow-hidden rounded-[12px] border transition-colors hover:bg-surface-hover ${
    isLive ? 'bg-warning/[0.04]' : 'bg-surface'
  } ${selected ? 'ring-2 ring-accent-bright/40' : ''} ${
    canOpen ? 'cursor-pointer focus-visible:outline-none' : ''
  }`;
}

// Inline because the console scope's wildcard border-color rule repaints Tailwind
// border utilities (see theme.css). Running cards get the design's amber tint.
function cardBorderColor(isLive: boolean, selected: boolean): string {
  if (selected) return 'color-mix(in oklch, var(--accent-bright), transparent 30%)';
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
      className="rounded p-1 text-text-tertiary opacity-0 transition-all hover:bg-surface-hover hover:text-text-primary group-hover:opacity-100"
    >
      <span aria-hidden className="font-mono text-[12px] leading-none">
        ↗
      </span>
    </button>
  );
}

function RunCardHeader({
  run,
  showProject,
  isLive,
}: {
  run: Run;
  showProject: boolean;
  isLive: boolean;
}): ReactElement {
  const isDocker = useIsDocker();
  const ideEnv = useIdeEnv();
  const elapsed = formatElapsed(elapsedSince(run.startedAt));
  const ideWorkingPath =
    !isDocker && hasValue(run.workingPath) && !run.id.startsWith('demo-') ? run.workingPath : null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <StatusDot run={run} isLive={isLive} />
      <span
        className={`shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em] ${statusTextClass[run.status]}`}
      >
        {runStatusLabel(run)}
      </span>
      <RunOutcomeBadge outcome={run.outcome} />
      <span className="mx-1 h-3 w-px shrink-0 bg-border" aria-hidden />
      <span className="text-sm font-medium text-text-primary">{run.workflow}</span>
      <span className="font-mono text-[11px] text-text-tertiary">{shortRunId(run.id)}</span>
      {showProject && run.projectName !== null ? (
        <span className="truncate text-[11px] text-text-secondary">· {run.projectName}</span>
      ) : null}
      <div className="ml-auto flex items-center gap-2">
        <OriginBadge origin={run.origin} />
        {typeof run.costUsd === 'number' ? (
          <span
            className="font-mono text-[11px] tabular-nums text-text-secondary"
            title="Total agent cost"
          >
            {formatCost(run.costUsd)}
          </span>
        ) : null}
        <span className="font-mono text-[11px] tabular-nums text-text-tertiary">
          {runElapsedLabel(run, elapsed)}
        </span>
        {ideWorkingPath !== null ? (
          <OpenInIdeButton workingPath={ideWorkingPath} ideEnv={ideEnv} />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Provenance + activity detail: the triggering input (when present, truncated — full
 * text on hover), plus node/tool rows while running.
 */
function RunDetailGrid({ run, isLive }: { run: Run; isLive: boolean }): ReactElement | null {
  const running = run.status === 'running';
  if (run.userMessage === '' && !running) return null;
  return (
    <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px]">
      {run.userMessage !== '' ? (
        <>
          <span className="font-mono text-text-tertiary">input</span>
          <span className="truncate font-mono text-text-secondary" title={run.userMessage}>
            {run.userMessage}
          </span>
        </>
      ) : null}
      {running && run.activeNodes.length > 0 ? (
        <>
          <span className="font-mono text-text-tertiary">
            {activeNodesLabel(run.activeNodes.length, isLive)}
          </span>
          <span className="font-mono text-text-primary">{run.activeNodes.join(', ')}</span>
        </>
      ) : null}
      {running && hasValue(run.lastTool) ? (
        <>
          <span className="font-mono text-text-tertiary">tool</span>
          <span className="font-mono text-text-primary">
            {run.lastTool}
            <ToolCursor live={isLive} />
          </span>
        </>
      ) : null}
    </div>
  );
}

function PromotedWaitPointer({ run }: { run: Run }): ReactElement {
  return (
    <div className="mt-2 rounded border border-warning/25 bg-warning/[0.05] px-3 py-2 text-[12px] text-warning">
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
    <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded border border-warning/25 bg-warning/[0.05] px-3 py-2 text-[12px]">
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
    <div className="mt-2 flex items-center gap-2 rounded border border-border bg-surface-hover/40 px-3 py-2 text-[12px] text-text-secondary">
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
 * Rich card for `running` and `paused` runs. These get attention.
 *
 * Running:
 *   - Pulsing blue live dot
 *   - Status strip pulses
 *   - Shows `node` + `tool` detail rows (mono) with a blinking cursor after
 *     the last tool name to reinforce "still working"
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
}: ActiveRunCardProps): ReactElement {
  const navigate = useNavigate();
  const attentionActions = useAttentionActions(run.id);
  const isLive = isRunLive(run);
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
      style={{ borderColor: cardBorderColor(isLive, selected) }}
    >
      <StatusStrip status={run.status} live={isLive} />
      <div className="pl-4 pr-4 py-3">
        <RunCardHeader run={run} showProject={showProject} isLive={isLive} />
        <OwnerObservationHint run={run} className="mt-1" />
        <ToolCallAttentionSection run={run} />
        <RunDetailGrid run={run} isLive={isLive} />
        <PausedRunSection run={run} inputPromoted={inputPromoted} actions={attentionActions} />
      </div>
    </article>
  );
}
