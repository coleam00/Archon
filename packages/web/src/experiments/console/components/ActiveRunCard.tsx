import type { ReactElement } from 'react';
import { useNavigate } from 'react-router';
import { StatusStrip } from './StatusStrip';
import { LiveDot } from './LiveDot';
import { OriginBadge } from './OriginBadge';
import { ApprovalPanel } from './ApprovalPanel';
import { ApprovalContext } from './ApprovalContext';
import type { Run } from '../primitives/run';
import { shortRunId, formatElapsed, elapsedSince } from '../lib/format';
import { statusTextClass, statusLabel } from '../lib/run-status';

interface ActiveRunCardProps {
  run: Run;
  showProject?: boolean;
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
 *   - Inline ApprovalPanel with context input + Approve/Reject
 *   - User can resolve without leaving the feed
 */
export function ActiveRunCard({ run, showProject = false }: ActiveRunCardProps): ReactElement {
  const navigate = useNavigate();
  const elapsed = formatElapsed(elapsedSince(run.startedAt));
  const canOpen = run.projectId !== null && !run.id.startsWith('demo-');

  const onCardClick = (): void => {
    if (canOpen) navigate(`/console/p/${run.projectId}/r/${run.id}`);
  };

  return (
    <article
      onClick={onCardClick}
      className={`group relative overflow-hidden rounded border border-border bg-surface transition-colors hover:bg-surface-hover ${
        canOpen ? 'cursor-pointer' : ''
      }`}
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
            <span className="font-mono text-[11px] tabular-nums text-text-tertiary">{elapsed}</span>
          </div>
        </div>

        {/* Activity detail — running only */}
        {run.status === 'running' ? (
          <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px]">
            {run.currentNode !== null && run.currentNode !== undefined && run.currentNode !== '' ? (
              <>
                <span className="font-mono text-text-tertiary">node</span>
                <span className="font-mono text-text-primary">{run.currentNode}</span>
              </>
            ) : null}
            {run.lastTool !== null && run.lastTool !== undefined && run.lastTool !== '' ? (
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
          <>
            <ApprovalContext run={run} />
            <ApprovalPanel run={run} />
          </>
        ) : null}
      </div>
    </article>
  );
}
