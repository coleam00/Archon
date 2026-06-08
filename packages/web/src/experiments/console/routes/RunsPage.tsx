import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { EmptyState } from '../components/EmptyState';
import { ActiveRunCard } from '../components/ActiveRunCard';
import { RecentRunRow } from '../components/RecentRunRow';
import { FilterChips, type Filter } from '../components/FilterChips';
import { ProjectViewTabs } from '../components/ProjectViewTabs';
import { DraftRunCard } from '../components/DraftRunCard';
import { PendingInputBanner } from '../components/PendingInputBanner';
import { useEntity } from '../store/cache';
import { K, type Scope } from '../store/keys';
import { useDashboardSSE } from '../lib/sse';
import { useKeymap, type Binding } from '../lib/keymap';
import * as skill from '../skills';
import type { Run } from '../primitives/run';
import type { RunCounts } from '../skills/runs';
import type { Project } from '../primitives/project';

interface FeedData {
  runs: Run[];
  counts: RunCounts;
  total: number;
}

const EMPTY_COUNTS: RunCounts = {
  all: 0,
  running: 0,
  paused: 0,
  failed: 0,
  completed: 0,
  cancelled: 0,
  pending: 0,
};

/**
 * Demo runs injected when `?demo=1` is in the URL. Lets us eyeball card colors
 * in context against whatever real runs exist. Ids start with `demo-` so the
 * detail-page navigation can be made a no-op later if needed.
 */
function buildDemoRuns(scope: Scope, projectName: string | null): Run[] {
  const now = Date.now();
  const iso = (secondsAgo: number): string => new Date(now - secondsAgo * 1000).toISOString();
  const project = scope === 'all' ? 'archon-core' : scope;
  const projName = projectName ?? 'archon-core';
  const base = {
    projectId: project,
    projectName: projName,
    costUsd: null as number | null,
    conversationId: null as string | null,
    conversationPlatformId: null as string | null,
    workingPath: null,
    userMessage: '',
    finishedAt: null as string | null,
  };
  return [
    {
      ...base,
      id: 'demo-running-1',
      workflow: 'plan',
      origin: 'cli',
      status: 'running',
      startedAt: iso(4 * 60 + 12),
      currentNode: 'plan/draft',
      lastTool: 'read_file',
    },
    {
      ...base,
      id: 'demo-running-2',
      workflow: 'implement',
      origin: 'web',
      status: 'running',
      startedAt: iso(9 * 60 + 38),
      currentNode: 'implement/loop',
      lastTool: 'edit_file',
    },
    {
      ...base,
      id: 'demo-paused-1',
      workflow: 'archon-interactive-prd',
      origin: 'web',
      status: 'paused',
      startedAt: iso(14 * 60 + 22),
      currentNode: 'foundation-gate',
      lastTool: null,
      approval: {
        nodeId: 'foundation-gate',
        message:
          'Answer the foundation questions above. Your answers will guide the research phase.',
      },
    },
    {
      ...base,
      id: 'demo-paused-2',
      workflow: 'review',
      origin: 'slack',
      status: 'paused',
      startedAt: iso(4 * 60 + 2),
      currentNode: 'review/approve',
      lastTool: null,
      approval: {
        nodeId: 'review/approve',
        message: 'Approve changes before opening PR?',
      },
    },
    {
      ...base,
      id: 'demo-failed-1',
      workflow: 'test',
      origin: 'github',
      status: 'failed',
      startedAt: iso(2 * 60 + 41),
      finishedAt: iso(0),
      currentNode: 'implement/verify',
      lastTool: null,
    },
    {
      ...base,
      id: 'demo-completed-1',
      workflow: 'assist',
      origin: 'telegram',
      status: 'completed',
      startedAt: iso(8 * 60 + 14),
      finishedAt: iso(0),
      currentNode: null,
      lastTool: null,
    },
  ] satisfies Run[];
}

function mergeCounts(a: RunCounts, b: RunCounts): RunCounts {
  return {
    all: a.all + b.all,
    running: a.running + b.running,
    paused: a.paused + b.paused,
    failed: a.failed + b.failed,
    completed: a.completed + b.completed,
    cancelled: a.cancelled + b.cancelled,
    pending: a.pending + b.pending,
  };
}

function countsFromRuns(runs: Run[]): RunCounts {
  const out: RunCounts = { ...EMPTY_COUNTS };
  for (const r of runs) {
    out.all += 1;
    if (r.status === 'running') out.running += 1;
    else if (r.status === 'paused') out.paused += 1;
    else if (r.status === 'failed') out.failed += 1;
    else if (r.status === 'completed') out.completed += 1;
    else if (r.status === 'cancelled') out.cancelled += 1;
  }
  return out;
}

function filterRuns(runs: Run[], filter: Filter, query: string): Run[] {
  const q = query.trim().toLowerCase();
  return runs.filter(r => {
    if (filter !== 'all' && r.status !== filter) return false;
    if (q.length === 0) return true;
    return (
      r.workflow.toLowerCase().includes(q) ||
      (r.projectName ?? '').toLowerCase().includes(q) ||
      r.id.toLowerCase().startsWith(q)
    );
  });
}

interface SectionHeaderProps {
  label: string;
  count: number;
}

function SectionHeader({ label, count }: SectionHeaderProps): ReactElement {
  return (
    <div className="mb-3 flex items-center gap-2.5 px-0.5">
      <span className="font-mono text-[11px] font-bold uppercase tracking-[0.13em] text-text-tertiary">
        {label}
      </span>
      <span
        className="rounded-full border bg-surface-elevated px-2 py-px font-mono text-[10.5px] tabular-nums text-text-secondary"
        style={{ borderColor: 'var(--border)' }}
      >
        {count}
      </span>
    </div>
  );
}

interface RunsFeedProps {
  runs: Run[];
  showProject: boolean;
  draftProject: { id: string; path: string } | null;
  selectedRunId: string | null;
  /** Run ids whose approval is currently shown in the pending-input banner. */
  promotedRunIds: ReadonlySet<string>;
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
function RunsFeed({
  runs,
  showProject,
  draftProject,
  selectedRunId,
  promotedRunIds,
}: RunsFeedProps): ReactElement {
  const active = runs.filter(r => r.status === 'running' || r.status === 'paused');
  const recent = runs.filter(
    r => r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled'
  );

  const showActiveSection = active.length > 0 || draftProject !== null;

  return (
    <div className="flex flex-col gap-[26px]">
      {showActiveSection ? (
        <section>
          <SectionHeader label="Active" count={active.length} />
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
              />
            ))}
          </div>
        </section>
      ) : null}

      {recent.length > 0 ? (
        <section>
          <SectionHeader label="Recent" count={recent.length} />
          <div className="flex flex-col overflow-hidden rounded-[12px] border border-border bg-surface">
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

export function RunsPage(): ReactElement {
  const { projectId } = useParams<{ projectId?: string }>();
  const navigate = useNavigate();
  const scope: Scope = projectId ?? 'all';
  const [searchParams] = useSearchParams();
  const demoMode = searchParams.get('demo') === '1';

  // Default to `running` — where the user's attention belongs. Completed is a
  // retrospective view, not the first thing to see.
  const [filter, setFilter] = useState<Filter>('running');
  const [query, setQuery] = useState('');
  // Selection index for j/k navigation. -1 = nothing selected.
  const [selectedIndex, setSelectedIndex] = useState<number>(-1);
  const searchRef = useRef<HTMLInputElement | null>(null);
  // Pending-input runs the user has dismissed from the banner this session.
  // Not persisted — the run is still paused, so it re-surfaces on reload.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());

  const { data, loading, error } = useEntity<FeedData>(K.runs(scope), () =>
    skill.listRuns(scope === 'all' ? {} : { codebaseId: scope })
  );

  // Dashboard SSE keeps the runs feed in sync: every workflow_status /
  // dag_node event invalidates the active runs:* cache keys, triggering a
  // refetch through useEntity. Replaces the 3s polling loop.
  useDashboardSSE();

  // Scoped project (drives the DraftRunCard inside the feed when not ALL).
  // Typed as `Project | null` rather than `Project` so the ALL scope can
  // legitimately resolve to null without a `null as unknown as Project`
  // type cast hiding the truth from later readers.
  const { data: project } = useEntity<Project | null>(
    scope === 'all' ? 'noop:scope-all' : K.project(scope),
    () => (scope === 'all' ? Promise.resolve(null) : skill.getProject(scope))
  );

  const realRuns = data?.runs ?? [];
  const realCounts = data?.counts ?? EMPTY_COUNTS;

  const demoRuns = useMemo(
    () => (demoMode ? buildDemoRuns(scope, project?.name ?? null) : []),
    [demoMode, scope, project?.name]
  );
  const demoCounts = useMemo(() => countsFromRuns(demoRuns), [demoRuns]);

  const allRuns = [...demoRuns, ...realRuns];
  const counts = demoMode ? mergeCounts(realCounts, demoCounts) : realCounts;
  const runs = useMemo(() => filterRuns(allRuns, filter, query), [allRuns, filter, query]);

  // Runs paused on a human gate (approval node / agent question). Derived from
  // the unfiltered set on purpose: a run that needs you should surface even
  // while the feed is filtered to `completed` or a search is active.
  const pendingRuns = useMemo(
    () =>
      allRuns.filter(r => r.status === 'paused' && r.approval !== null && r.approval !== undefined),
    [allRuns]
  );

  // Drop dismissed ids that are no longer pending so a run that pauses again
  // (a later approval node, or a repeating interactive loop gate) re-surfaces
  // instead of staying suppressed for the rest of the session.
  useEffect(() => {
    setDismissed(prev => {
      if (prev.size === 0) return prev;
      const pendingIds = new Set(pendingRuns.map(r => r.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (pendingIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [pendingRuns]);

  const visiblePending = useMemo(
    () => pendingRuns.filter(r => !dismissed.has(r.id)),
    [pendingRuns, dismissed]
  );
  const promotedRunIds = useMemo(() => new Set(visiblePending.map(r => r.id)), [visiblePending]);

  const heading = scope === 'all' ? 'All projects' : (project?.name ?? 'Project');
  const hasScopedProject = scope !== 'all' && project !== undefined && project !== null;
  const draftProject = hasScopedProject ? { id: project.id, path: project.path } : null;

  // Clamp selection when the visible run set changes so j/k never lands on
  // an out-of-range index after a filter / search shrinks the list.
  useEffect(() => {
    if (selectedIndex >= runs.length) setSelectedIndex(runs.length - 1);
  }, [runs.length, selectedIndex]);

  const selectedRun = selectedIndex >= 0 ? (runs[selectedIndex] ?? null) : null;
  const selectedRunId = selectedRun?.id ?? null;

  // Scroll the selected row into view after j/k moves the index. The
  // RecentRunRow / ActiveRunCard emit a data attribute we can target.
  // CSS.escape guards against ids containing CSS-special chars (`:`, `.`,
  // etc.) — without it the selector throws SyntaxError.
  useEffect(() => {
    if (selectedRunId === null) return;
    const el = document.querySelector(`[data-run-id="${CSS.escape(selectedRunId)}"]`);
    if (el !== null) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedRunId]);

  const open = (id: string, projId: string | null): void => {
    if (projId === null) return;
    navigate(`/console/p/${projId}/r/${id}`);
  };

  const bindings = useMemo<readonly Binding[]>(
    () => [
      {
        keys: ['j'],
        label: 'Move down',
        run: (): void => {
          if (runs.length === 0) return;
          setSelectedIndex(i => Math.min(runs.length - 1, (i < 0 ? -1 : i) + 1));
        },
      },
      {
        keys: ['k'],
        label: 'Move up',
        run: (): void => {
          if (runs.length === 0) return;
          setSelectedIndex(i => Math.max(0, (i < 0 ? runs.length : i) - 1));
        },
      },
      {
        keys: ['g', 'g'],
        label: 'Jump to first',
        run: (): void => {
          if (runs.length > 0) setSelectedIndex(0);
        },
      },
      {
        keys: ['G'],
        label: 'Jump to last',
        run: (): void => {
          if (runs.length > 0) setSelectedIndex(runs.length - 1);
        },
      },
      {
        keys: ['Enter'],
        label: 'Open selected',
        when: (): boolean => selectedRun !== null,
        run: (): void => {
          if (selectedRun !== null) open(selectedRun.id, selectedRun.projectId);
        },
      },
      {
        keys: ['Escape'],
        label: 'Clear selection',
        when: (): boolean => selectedIndex !== -1,
        run: (): void => {
          setSelectedIndex(-1);
        },
      },
      {
        keys: ['/'],
        label: 'Focus search',
        run: (): void => {
          searchRef.current?.focus();
          searchRef.current?.select();
        },
      },
      {
        keys: ['1'],
        label: 'Filter: running',
        run: (): void => {
          setFilter('running');
          setSelectedIndex(-1);
        },
      },
      {
        keys: ['2'],
        label: 'Filter: paused',
        run: (): void => {
          setFilter('paused');
          setSelectedIndex(-1);
        },
      },
      {
        keys: ['3'],
        label: 'Filter: failed',
        run: (): void => {
          setFilter('failed');
          setSelectedIndex(-1);
        },
      },
      {
        keys: ['4'],
        label: 'Filter: completed',
        run: (): void => {
          setFilter('completed');
          setSelectedIndex(-1);
        },
      },
      {
        keys: ['5'],
        label: 'Filter: all',
        run: (): void => {
          setFilter('all');
          setSelectedIndex(-1);
        },
      },
    ],
    [runs, selectedIndex, selectedRun]
  );
  useKeymap({ bindings });

  return (
    <section className="flex h-full flex-col">
      <header className="flex flex-col gap-3 border-b border-border px-6 py-4">
        <div className="flex items-baseline justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-base font-medium text-text-primary">{heading}</h1>
            <p className="text-xs text-text-tertiary">
              {scope === 'all' ? 'Every run, across every project.' : (project?.path ?? 'Loading…')}
              {demoMode ? (
                <span className="ml-2 rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest text-warning">
                  demo mocks on
                </span>
              ) : null}
            </p>
          </div>
          <div
            className="flex h-[38px] w-[300px] max-w-[34vw] shrink-0 items-center gap-2 rounded-[10px] border bg-surface-elevated px-3 text-text-tertiary transition-colors focus-within:text-text-secondary"
            // Inline because the console scope's wildcard border-color rule
            // repaints Tailwind border utilities (see theme.css).
            style={{ borderColor: 'var(--border)' }}
          >
            <span aria-hidden className="font-mono text-[13px] leading-none">
              ⌕
            </span>
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={e => {
                setQuery(e.target.value);
              }}
              onKeyDown={e => {
                // Esc unfocuses + clears so `/` → type → esc returns control
                // to the global keymap without trapping the user in the box.
                if (e.key === 'Escape') {
                  e.currentTarget.blur();
                  setQuery('');
                }
              }}
              placeholder="Search workflow, project, run id…"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] text-text-primary outline-none placeholder:text-text-tertiary"
            />
          </div>
        </div>

        {scope === 'all' ? (
          <div className="rounded border border-dashed border-border bg-surface-inset/60 px-3 py-2 text-[12px] text-text-tertiary">
            Pick a project on the left to start a run.
          </div>
        ) : (
          <ProjectViewTabs projectId={scope} active="runs" />
        )}
      </header>

      {/* Status sub-tabs — their own strip; the active underline overlaps the
          hairline below (design: .subtabs). */}
      <div className="border-b border-border px-6">
        <FilterChips value={filter} onChange={setFilter} counts={counts} />
      </div>

      <PendingInputBanner
        runs={visiblePending}
        showProject={scope === 'all'}
        onDismiss={runId => {
          setDismissed(prev => {
            const next = new Set(prev);
            next.add(runId);
            return next;
          });
        }}
      />

      <div className="flex-1 overflow-y-auto px-[30px] pb-[30px] pt-[22px]">
        {error !== undefined && !demoMode ? (
          <EmptyState title="Could not load runs." hint={error.message} />
        ) : loading && !demoMode ? (
          <EmptyState title="Loading…" />
        ) : runs.length === 0 && draftProject === null ? (
          <EmptyState
            title={
              filter === 'running'
                ? 'Nothing running right now.'
                : filter === 'all'
                  ? 'No runs yet.'
                  : `No ${filter} runs.`
            }
            hint={scope === 'all' ? 'Start one from a project.' : undefined}
          />
        ) : (
          <RunsFeed
            runs={runs}
            showProject={scope === 'all'}
            draftProject={draftProject}
            selectedRunId={selectedRunId}
            promotedRunIds={promotedRunIds}
          />
        )}
      </div>
    </section>
  );
}
