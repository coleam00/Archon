import { useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import { useDashboardSSE } from '../lib/sse';
import { ApprovalContext } from './ApprovalContext';
import { ApprovalPanel } from './ApprovalPanel';
import * as skill from '../skills';
import type { Run } from '../primitives/run';
import type { RunCounts } from '../skills/runs';
import { statusDotClass, statusLabel } from '../lib/run-status';
import { shortRunId, formatElapsed, elapsedSince } from '../lib/format';

interface FeedData {
  runs: Run[];
  counts: RunCounts;
  total: number;
}

interface WorkflowDockProps {
  projectId: string;
}

function needsApproval(run: Run): boolean {
  return run.status === 'paused' && run.approval !== null && run.approval !== undefined;
}

/**
 * Pinned tray of the project's in-progress workflow runs, docked below the chat
 * stream (above the composer) so it persists while messages scroll.
 *
 * Runs paused on a human gate render their approval inline (reusing
 * ApprovalContext + ApprovalPanel — same approve/reject + comment-injection as
 * everywhere else) so you can act without leaving the chat. They're always
 * shown — a paused run needs you. Plain running runs follow a 1-vs-N collapse:
 *
 *   0 active  → hidden
 *   1 running → the richer single card directly
 *   2+        → collapsed "Running workflows (N) ▸"; the chevron expands.
 *
 * Live via the dashboard SSE (which invalidates the shared runs cache).
 */
export function WorkflowDock({ projectId }: WorkflowDockProps): ReactElement | null {
  const [expanded, setExpanded] = useState(false);

  const { data } = useEntity<FeedData>(K.runs(projectId), () =>
    skill.listRuns({ codebaseId: projectId })
  );
  useDashboardSSE();

  const active = (data?.runs ?? []).filter(r => r.status === 'running' || r.status === 'paused');
  if (active.length === 0) return null;

  const approvals = active.filter(needsApproval);
  const running = active.filter(r => !needsApproval(r));
  const singleRunning = running.length === 1;
  const showRunningCards = singleRunning || expanded;

  return (
    <div className="max-h-[55vh] shrink-0 overflow-y-auto border-t border-border bg-surface-inset/60 px-6 py-2">
      {approvals.map(run => (
        <ApprovalDockCard key={run.id} run={run} />
      ))}

      {running.length > 0 ? (
        <>
          {!singleRunning ? (
            <button
              type="button"
              onClick={() => {
                setExpanded(v => !v);
              }}
              className="mb-1.5 flex w-full items-center gap-2 text-left"
            >
              <span aria-hidden className="font-mono text-[10px] text-text-tertiary">
                {expanded ? '▾' : '▸'}
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-text-secondary">
                Running workflows
              </span>
              <span className="font-mono text-[11px] tabular-nums text-text-tertiary">
                {running.length.toString()}
              </span>
              {!expanded ? (
                <span className="ml-auto flex items-center gap-1.5">
                  {running.slice(0, 5).map(r => (
                    <span
                      key={r.id}
                      aria-hidden
                      className={`h-2 w-2 rounded-full ${statusDotClass[r.status]}`}
                    />
                  ))}
                </span>
              ) : null}
            </button>
          ) : null}

          {showRunningCards ? (
            <div className="flex flex-col gap-1.5">
              {running.map(run => (
                <DockCard key={run.id} run={run} />
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** Paused run awaiting approval — actionable inline via the shared components. */
function ApprovalDockCard({ run }: { run: Run }): ReactElement {
  const navigate = useNavigate();

  return (
    <article className="mb-1.5 rounded border border-warning/40 bg-warning/[0.05] p-3">
      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span aria-hidden className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-warning" />
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-warning">
          Waiting for approval
        </span>
        <span className="text-[13px] font-medium text-text-primary">{run.workflow}</span>
        <span className="font-mono text-[10px] text-text-tertiary">{shortRunId(run.id)}</span>
        <button
          type="button"
          onClick={() => {
            if (run.projectId !== null) navigate(`/console/p/${run.projectId}/r/${run.id}`);
          }}
          className="ml-auto shrink-0 font-mono text-[11px] text-text-tertiary transition-colors hover:text-text-primary"
        >
          Open logs →
        </button>
      </div>
      <ApprovalContext run={run} />
      <ApprovalPanel run={run} />
    </article>
  );
}

/** Plain running run — links to the run-detail logs. */
function DockCard({ run }: { run: Run }): ReactElement {
  const navigate = useNavigate();
  const elapsed = formatElapsed(elapsedSince(run.startedAt));
  const node = run.currentNode !== null && run.currentNode !== undefined ? run.currentNode : null;

  return (
    <button
      type="button"
      onClick={() => {
        if (run.projectId !== null) navigate(`/console/p/${run.projectId}/r/${run.id}`);
      }}
      title="Open run logs"
      className="flex items-center gap-3 rounded border border-border bg-surface px-3 py-2 text-left transition-colors hover:border-border-bright hover:bg-surface-hover"
    >
      <span
        aria-hidden
        className={`h-2.5 w-2.5 shrink-0 rounded-full ${statusDotClass[run.status]}`}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-text-primary">{run.workflow}</span>
          <span className="font-mono text-[10px] text-text-tertiary">{shortRunId(run.id)}</span>
        </span>
        <span className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-text-tertiary">
          <span className="text-text-secondary">{statusLabel[run.status]}</span>
          {node !== null ? (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{node}</span>
            </>
          ) : null}
        </span>
      </span>
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-text-tertiary">
        {elapsed}
      </span>
      <span aria-hidden className="shrink-0 font-mono text-[11px] text-text-tertiary">
        ↗
      </span>
    </button>
  );
}
