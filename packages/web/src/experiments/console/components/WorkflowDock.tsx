import { useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import { useDashboardSSE } from '../lib/sse';
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

/**
 * Pinned tray of the project's in-progress workflow runs, docked below the chat
 * stream (above the composer) so it persists while messages scroll.
 *
 *   0 running → hidden
 *   1 running → the richer single card directly
 *   2+        → collapsed "Running workflows (N) ▸"; the chevron expands to
 *               stack the richer cards.
 *
 * Each card links to the run-detail logs. Live via the dashboard SSE (which
 * invalidates the shared runs cache).
 */
export function WorkflowDock({ projectId }: WorkflowDockProps): ReactElement | null {
  const [expanded, setExpanded] = useState(false);

  const { data } = useEntity<FeedData>(K.runs(projectId), () =>
    skill.listRuns({ codebaseId: projectId })
  );
  useDashboardSSE();

  const active = (data?.runs ?? []).filter(r => r.status === 'running' || r.status === 'paused');

  if (active.length === 0) return null;

  const single = active.length === 1;
  const showCards = single || expanded;

  return (
    <div className="shrink-0 border-t border-border bg-surface-inset/60 px-6 py-2">
      {!single ? (
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
            {active.length.toString()}
          </span>
          {!expanded ? (
            <span className="ml-auto flex items-center gap-1.5">
              {active.slice(0, 5).map(r => (
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

      {showCards ? (
        <div className="flex flex-col gap-1.5">
          {active.map(run => (
            <DockCard key={run.id} run={run} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

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
