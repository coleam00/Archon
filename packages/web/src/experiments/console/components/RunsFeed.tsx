import type { ReactElement } from 'react';
import { ActiveRunCard } from './ActiveRunCard';
import { DraftRunCard } from './DraftRunCard';
import { RecentRunRow } from './RecentRunRow';
import type { Run } from '../primitives/run';

interface SectionHeaderProps {
  label: string;
  count: number | null;
}

function SectionHeader({ label, count }: SectionHeaderProps): ReactElement {
  return (
    <div className="mb-3 flex items-center gap-2.5 px-0.5">
      <span className="font-mono text-console-11 font-bold uppercase tracking-console-label text-text-tertiary">
        {label}
      </span>
      {count !== null ? (
        <span
          className="rounded-full border bg-surface-elevated px-2 py-px font-mono text-console-11 tabular-nums text-text-secondary"
          style={{ borderColor: 'var(--border)' }}
        >
          {count}
        </span>
      ) : null}
    </div>
  );
}

export interface RunsFeedProps {
  runs: Run[];
  showProject: boolean;
  draftProject: { id: string; path: string } | null;
  selectedRunId: string | null;
  /** Run ids whose actions are currently shown in the pending-input banner. */
  promotedRunIds: ReadonlySet<string>;
  /** Heading of the finished runs: on the Running tab they are the ones that just ended. */
  recentLabel: string;
  /** Whether every active card shows its details; one page-level switch sets it. */
  expanded: boolean;
  /** Shown in place of the runs while none are known (loading, or the load failed). */
  notice: ReactElement | null;
}

/**
 * Feed split into Active (running + paused) and Recent (completed / failed /
 * cancelled). Active cards get real estate; Recent collapses to compact rows.
 * Matches the attention model: completed runs rarely get checked unless
 * something went wrong — so failed stays eye-catching, completed is muted.
 *
 * When a project is scoped, a DraftRunCard sits at the top of Active — same
 * card shape as a paused-approval card, just waiting for YOU instead of
 * the agent. Starting a new run is "another card in the list."
 */
export function RunsFeed({
  runs,
  showProject,
  draftProject,
  selectedRunId,
  promotedRunIds,
  recentLabel,
  expanded,
  notice,
}: RunsFeedProps): ReactElement {
  const active = runs.filter(r => r.status === 'running' || r.status === 'paused');
  const recent = runs.filter(
    r => r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled'
  );

  const showActiveSection = active.length > 0 || draftProject !== null;

  return (
    <div className="flex flex-col gap-6.5">
      {showActiveSection ? (
        <section>
          <SectionHeader label="Active" count={notice !== null ? null : active.length} />
          <div className="flex flex-col gap-2">
            {draftProject !== null ? (
              <DraftRunCard projectId={draftProject.id} projectCwd={draftProject.path} />
            ) : null}
            {active.map(run => (
              <ActiveRunCard
                key={run.id}
                run={run}
                showProject={showProject}
                selected={run.id === selectedRunId}
                inputPromoted={promotedRunIds.has(run.id)}
                expanded={expanded}
              />
            ))}
          </div>
        </section>
      ) : null}

      {notice}
      {recent.length > 0 ? (
        <section>
          <SectionHeader label={recentLabel} count={recent.length} />
          <div className="flex flex-col overflow-hidden rounded-console-12 border border-border bg-surface">
            {recent.map(run => (
              <RecentRunRow
                key={run.id}
                run={run}
                showProject={showProject}
                selected={run.id === selectedRunId}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
