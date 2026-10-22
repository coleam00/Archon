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
import { shortRunId, formatElapsed, elapsedSince, formatRunCost } from '../lib/format';
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
  const isDocker = useIsDocker();
  const ideEnv = useIdeEnv();
  const isLive = isRunLive(run);
  const elapsed = formatElapsed(elapsedSince(run.startedAt));
  const canOpen = !run.id.startsWith('demo-');
  const canOpenIde =
    !isDocker && run.workingPath !== null && run.workingPath !== '' && !run.id.startsWith('demo-');
  const showDetailGrid = run.userMessage !== '' || run.status === 'running';
  const [attentionBusy, setAttentionBusy] = useState<'resume' | 'abandon' | null>(null);
  const [attentionError, setAttentionError] = useState<string | null>(null);

  const resolveAttention = async (action: 'resume' | 'abandon'): Promise<void> => {
    setAttentionBusy(action);
    setAttentionError(null);
    try {
      if (!run.id.startsWith('demo-')) {
        if (action === 'resume') await skill.resumeRun(run.id);
        else await skill.abandonRun(run.id);
      }
      invalidate('runs');
      invalidate(K.run(run.id));
    } catch (error: unknown) {
      setAttentionError(error instanceof Error ? error.message : 'Action failed.');
    } finally {
      setAttentionBusy(null);
    }
  };

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
      className={`group relative overflow-hidden rounded-[12px] border transition-colors hover:bg-surface-hover ${
        isLive ? 'bg-warning/[0.04]' : 'bg-surface'
      } ${selected ? 'ring-2 ring-accent-bright/40' : ''} ${
        canOpen ? 'cursor-pointer focus-visible:outline-none' : ''
      }`}
      // Inline because the console scope's wildcard border-color rule
      // repaints Tailwind border utilities (see theme.css). Running cards
      // get the design's amber tint.
      style={{
        borderColor: selected
          ? 'color-mix(in oklch, var(--accent-bright), transparent 30%)'
          : isLive
            ? 'color-mix(in oklch, var(--warning), transparent 70%)'
            : 'var(--border)',
      }}
    >
      <StatusStrip status={run.status} live={isLive} />
      <div className="pl-4 pr-4 py-3">
        {/* Header */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {run.status === 'running' ? (
            <RunningDot live={isLive} />
          ) : (
            <span
              aria-hidden
              className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-warning"
            />
          )}
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
            {formatRunCost(run) !== null ? (
              <span
                className="font-mono text-[11px] tabular-nums text-text-secondary"
                title="Reported agent cost"
              >
                {formatRunCost(run)}
              </span>
            ) : null}
            <span className="font-mono text-[11px] tabular-nums text-text-tertiary">
              {runElapsedLabel(run, elapsed)}
            </span>
            {canOpenIde && run.workingPath !== null ? (
              <button
                type="button"
                onClick={e => {
                  e.stopPropagation();
                  if (run.workingPath !== null) openInIde(run.workingPath, ideEnv);
                }}
                title={`Open ${run.workingPath} in IDE`}
                aria-label="Open in IDE"
                className="rounded p-1 text-text-tertiary opacity-0 transition-all hover:bg-surface-hover hover:text-text-primary group-hover:opacity-100"
              >
                <span aria-hidden className="font-mono text-[12px] leading-none">
                  ↗
                </span>
              </button>
            ) : null}
          </div>
        </div>

        <OwnerObservationHint run={run} className="mt-1" />

        <ToolCallAttentionSection run={run} />

        {/* Provenance + activity detail: the triggering input (when present, truncated —
            full text on hover), plus node/tool rows while running. */}
        {showDetailGrid ? (
          <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px]">
            {run.userMessage !== '' ? (
              <>
                <span className="font-mono text-text-tertiary">input</span>
                <span className="truncate font-mono text-text-secondary" title={run.userMessage}>
                  {run.userMessage}
                </span>
              </>
            ) : null}
            {run.status === 'running' && run.activeNodes.length > 0 ? (
              <>
                <span className="font-mono text-text-tertiary">
                  {activeNodesLabel(run.activeNodes.length, isLive)}
                </span>
                <span className="font-mono text-text-primary">{run.activeNodes.join(', ')}</span>
              </>
            ) : null}
            {run.status === 'running' && hasValue(run.lastTool) ? (
              <>
                <span className="font-mono text-text-tertiary">tool</span>
                <span className="font-mono text-text-primary">
                  {run.lastTool}
                  <ToolCursor live={isLive} />
                </span>
              </>
            ) : null}
          </div>
        ) : null}

        {run.status === 'paused' && inputPromoted ? (
          <div className="mt-2 rounded border border-warning/25 bg-warning/[0.05] px-3 py-2 text-[12px] text-warning">
            {run.attention?.kind === 'usage_limit'
              ? 'Waiting on a provider limit — see the banner at the top.'
              : 'Waiting for your input — see the banner at the top.'}
          </div>
        ) : null}

        {run.status === 'paused' && !inputPromoted && run.wait != null ? (
          <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded border border-warning/25 bg-warning/[0.05] px-3 py-2 text-[12px]">
            <span className="font-mono text-text-tertiary">node</span>
            <span className="font-mono text-text-primary">{run.wait.nodeId}</span>
            {run.wait.kind === 'event' && run.wait.event !== undefined ? (
              <>
                <span className="font-mono text-text-tertiary">event</span>
                <span className="font-mono text-text-primary">{run.wait.event}</span>
              </>
            ) : null}
            {run.attention?.kind === 'attention' ? (
              <>
                <span className="font-mono text-text-tertiary">needs</span>
                <span className="text-text-secondary">{run.attention.message}</span>
                <span className="font-mono text-text-tertiary">answer</span>
                <span className="flex flex-col gap-1">
                  <AttentionAnswerPanel run={run} attention={run.attention} />
                  <span className="flex flex-wrap items-center gap-2">
                    {isLegacyAttention(run.attention) ? (
                      <button
                        type="button"
                        onClick={event => {
                          event.stopPropagation();
                          void resolveAttention('resume');
                        }}
                        disabled={attentionBusy !== null}
                        className="rounded bg-warning/15 px-2 py-1 font-semibold text-warning hover:bg-warning/25 disabled:opacity-50"
                      >
                        {attentionBusy === 'resume' ? 'Resuming…' : 'Resume'}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={event => {
                        event.stopPropagation();
                        void resolveAttention('abandon');
                      }}
                      disabled={attentionBusy !== null}
                      className="rounded px-2 py-1 text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
                    >
                      {attentionBusy === 'abandon' ? 'Abandoning…' : 'Abandon'}
                    </button>
                    {attentionError !== null ? (
                      <span className="font-mono text-error">{attentionError}</span>
                    ) : null}
                  </span>
                </span>
              </>
            ) : run.wait.kind !== 'attention' ? (
              <>
                <span className="font-mono text-text-tertiary">
                  {run.wait.kind === 'event' ? 'deadline' : 'resume'}
                </span>
                <span className="font-mono text-text-secondary">
                  {new Date(run.wait.resumeAt).toLocaleString()}
                </span>
              </>
            ) : null}
          </div>
        ) : null}

        {/* Approval surface — paused only.
            The context block shows the actual question the agent asked (pulled
            from the last text event), because the approval node's own
            `message` is usually just a pointer ("answer the questions above"). */}
        {!inputPromoted && run.attention?.kind === 'awaiting_response' ? (
          <>
            <ApprovalContext run={run} />
            <ApprovalPanel run={run} />
          </>
        ) : null}

        {/* Resolved gate awaiting auto-resume — the run is still 'paused' in the
            DB for the second or so between approve/reject and the executor
            flipping it to running. Show a hint instead of stale gate buttons. */}
        {run.status === 'paused' && run.gateResolved !== null && run.gateResolved !== undefined ? (
          <div className="mt-2 flex items-center gap-2 rounded border border-border bg-surface-hover/40 px-3 py-2 text-[12px] text-text-secondary">
            <span aria-hidden className="inline-block animate-pulse leading-none">
              ▸
            </span>
            <span>
              {run.gateResolved === 'approved'
                ? 'Approved — resuming…'
                : 'Rejected — running on-reject rework…'}
            </span>
          </div>
        ) : null}
      </div>
    </article>
  );
}
