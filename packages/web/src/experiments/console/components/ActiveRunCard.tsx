import type { ReactElement } from 'react';
import { useNavigate } from 'react-router';
import { StatusStrip } from './StatusStrip';
import { LiveDot } from './LiveDot';
import { OriginBadge } from './OriginBadge';
import { ApprovalPanel } from './ApprovalPanel';
import { ApprovalContext } from './ApprovalContext';
import type { Run } from '../primitives/run';
import { shortRunId, formatElapsed, elapsedSince, formatCost } from '../lib/format';
import { useIsDocker, openInIde } from '../lib/health';
import { statusTextClass, statusLabel } from '../lib/run-status';

/** Present + non-empty — narrows `string | null | undefined` to `string`. */
const hasValue = (v: string | null | undefined): v is string => v != null && v !== '';

interface ActiveRunCardProps {
  run: Run;
  showProject?: boolean;
  selected?: boolean;
  /**
   * True when this run's approval is currently surfaced in the pending-input
   * banner at the top of the feed. The card then shows a pointer instead of a
   * second live ApprovalPanel; dismissing the banner restores the inline panel.
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
  const elapsed = formatElapsed(elapsedSince(run.startedAt));
  const canOpen = run.projectId !== null && !run.id.startsWith('demo-');
  const canOpenIde =
    !isDocker && run.workingPath !== null && run.workingPath !== '' && !run.id.startsWith('demo-');
  const showDetailGrid = run.userMessage !== '' || run.status === 'running';

  const onCardClick = (): void => {
    if (canOpen) navigate(`/console/p/${run.projectId}/r/${run.id}`);
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
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onCardClick();
              }
            }
          : undefined
      }
      className={`group relative overflow-hidden rounded border bg-surface transition-colors hover:bg-surface-hover ${
        selected ? 'border-accent-bright/70 ring-2 ring-accent-bright/40' : 'border-border'
      } ${canOpen ? 'cursor-pointer focus-visible:outline-none' : ''}`}
    >
      <StatusStrip status={run.status} />
      <div className="pl-4 pr-4 py-3">
        {/* Header */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {run.status === 'running' ? (
            <LiveDot />
          ) : (
            <span
              aria-hidden
              className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-warning"
            />
          )}
          <span
            className={`shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em] ${statusTextClass[run.status]}`}
          >
            {statusLabel[run.status]}
          </span>
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
            <span className="font-mono text-[11px] tabular-nums text-text-tertiary">{elapsed}</span>
            {canOpenIde && run.workingPath !== null ? (
              <button
                type="button"
                onClick={e => {
                  e.stopPropagation();
                  if (run.workingPath !== null) openInIde(run.workingPath);
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

        {/* Provenance + activity detail: the triggering input (when present, truncated —
            full text on hover), plus live node/tool rows while running. */}
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
            {run.status === 'running' && hasValue(run.currentNode) ? (
              <>
                <span className="font-mono text-text-tertiary">node</span>
                <span className="font-mono text-text-primary">{run.currentNode}</span>
              </>
            ) : null}
            {run.status === 'running' && hasValue(run.lastTool) ? (
              <>
                <span className="font-mono text-text-tertiary">tool</span>
                <span className="font-mono text-text-primary">
                  {run.lastTool}
                  <span aria-hidden className="ml-1 inline-block animate-pulse">
                    ▏
                  </span>
                </span>
              </>
            ) : null}
          </div>
        ) : null}

        {/* Approval surface — paused only.
            The context block shows the actual question the agent asked (pulled
            from the last text event), because the approval node's own
            `message` is usually just a pointer ("answer the questions above"). */}
        {run.status === 'paused' && run.approval !== null && run.approval !== undefined ? (
          inputPromoted ? (
            <div className="mt-2 flex items-center gap-2 rounded border border-warning/25 bg-warning/[0.05] px-3 py-2 text-[12px] text-warning">
              <span aria-hidden className="leading-none">
                ⚠
              </span>
              <span>Waiting for your input — see the banner at the top.</span>
            </div>
          ) : (
            <>
              <ApprovalContext run={run} />
              <ApprovalPanel run={run} />
            </>
          )
        ) : null}
      </div>
    </article>
  );
}
