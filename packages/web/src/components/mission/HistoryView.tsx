import { useState, useMemo } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { RotateCcw, Search } from 'lucide-react';
import { listDashboardRuns, listCodebases } from '@/lib/api';
import type { DashboardRunResponse, DashboardRunsResult } from '@/lib/api';
import type { WorkflowRunStatus } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  Mono,
  ProviderChip,
  StatusChip,
  fmtAgo,
  fmtDur,
  runIdentifier,
  runProvider,
} from './primitives';

type StatusFilter = 'all' | WorkflowRunStatus;
const FILTERS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'paused', label: 'Awaiting' },
  { id: 'completed', label: 'Completed' },
  { id: 'failed', label: 'Failed' },
];

interface HistoryViewProps {
  onOpenRun: (runId: string) => void;
}

export function HistoryView({ onOpenRun }: HistoryViewProps): React.ReactElement {
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [codebaseId, setCodebaseId] = useState('');
  const [search, setSearch] = useState('');

  const { data: codebases } = useQuery({
    queryKey: ['mission.codebases'],
    queryFn: listCodebases,
  });

  const queryKey = useMemo(
    () => ['missionHistory', { filter, codebaseId, search }] as const,
    [filter, codebaseId, search]
  );

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery<DashboardRunsResult>({
      queryKey,
      initialPageParam: undefined as string | undefined,
      queryFn: ({ pageParam }) =>
        listDashboardRuns({
          status: filter === 'all' ? undefined : filter,
          codebaseId: codebaseId || undefined,
          search: search || undefined,
          limit: 50,
          cursor: pageParam as string | undefined,
        }),
      getNextPageParam: last => last.nextCursor ?? undefined,
    });

  const rows: DashboardRunResponse[] = useMemo(() => {
    if (!data) return [];
    const out: DashboardRunResponse[] = [];
    for (const page of data.pages) out.push(...page.runs);
    return out;
  }, [data]);

  const total = data?.pages[0]?.total ?? 0;

  return (
    <div className="px-6 pb-6 pt-4">
      <div className="mb-3.5 flex items-center gap-2.5">
        <h1 className="m-0 text-[18px] font-semibold tracking-tight text-bridges-fg1">History</h1>
        <span className="ml-1 text-[13px] text-bridges-fg3">
          {rows.length} of {total} runs
        </span>
        <div className="flex-1" />

        {codebases && codebases.length > 1 && (
          <select
            aria-label="Filter by codebase"
            value={codebaseId}
            onChange={e => {
              setCodebaseId(e.target.value);
            }}
            className="rounded-md border border-bridges-border bg-bridges-surface px-2 py-1 text-[12px] text-bridges-fg1"
          >
            <option value="">All codebases</option>
            {codebases.map(cb => (
              <option key={cb.id} value={cb.id}>
                {cb.name}
              </option>
            ))}
          </select>
        )}

        <div className="inline-flex rounded-md bg-bridges-surface-muted p-0.5">
          {FILTERS.map(f => (
            <button
              key={f.id}
              onClick={() => {
                setFilter(f.id);
              }}
              className={cn(
                'rounded px-3 py-1 text-[12px] font-medium transition-colors',
                filter === f.id
                  ? 'bg-bridges-surface text-bridges-fg1 shadow-[0_1px_2px_rgba(15,15,18,0.06)]'
                  : 'text-bridges-fg2 hover:text-bridges-fg1'
              )}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="flex w-[240px] items-center gap-2 rounded-md border border-bridges-border bg-bridges-surface px-2.5 py-1 text-[13px] text-bridges-fg1">
          <Search className="h-3.5 w-3.5 text-bridges-fg3" />
          <input
            value={search}
            onChange={e => {
              setSearch(e.target.value);
            }}
            placeholder="Filter…"
            className="min-w-0 flex-1 border-none bg-transparent text-[13px] text-bridges-fg1 outline-none placeholder:text-bridges-fg-placeholder"
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-bridges-border bg-bridges-surface">
        <div className="grid grid-cols-[120px_1fr_140px_140px_110px_110px_90px_36px] border-b border-bridges-border-subtle bg-bridges-bg px-3.5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-bridges-fg3">
          <div>ID</div>
          <div>Workflow</div>
          <div>Status</div>
          <div>Codebase</div>
          <div>Provider</div>
          <div>Started</div>
          <div className="text-right">Duration</div>
          <div />
        </div>

        {isLoading && <p className="px-4 py-8 text-center text-sm text-bridges-fg2">Loading…</p>}
        {!isLoading && rows.length === 0 && (
          <p className="px-4 py-8 text-center text-[12.5px] text-bridges-fg3">
            No runs match these filters.
          </p>
        )}

        {rows.map((run, i) => (
          <button
            key={run.id}
            type="button"
            onClick={() => {
              onOpenRun(run.id);
            }}
            className={cn(
              'grid w-full grid-cols-[120px_1fr_140px_140px_110px_110px_90px_36px] items-center px-3.5 py-2.5 text-[13px] transition-colors hover:bg-bridges-surface-subtle',
              i !== rows.length - 1 && 'border-b border-bridges-border-subtle'
            )}
          >
            <Mono className="text-[11.5px] text-bridges-fg1">{runIdentifier(run)}</Mono>
            <div className="min-w-0 truncate pr-3 text-left text-bridges-fg1">
              {run.workflow_name}
            </div>
            <div>
              <StatusChip status={run.status} />
            </div>
            <div className="truncate font-mono text-[12px] text-bridges-fg2">
              {run.codebase_name ?? '—'}
            </div>
            <div>
              <ProviderChip provider={runProvider(run)} />
            </div>
            <div className="text-left text-[12px] text-bridges-fg2">{fmtAgo(run.started_at)}</div>
            <div className="text-right font-mono text-[12px] text-bridges-fg2">
              {fmtDur(run.started_at, run.completed_at ?? Date.now())}
            </div>
            <div className="text-right">
              <RotateCcw className="ml-auto h-3.5 w-3.5 text-bridges-fg3" />
            </div>
          </button>
        ))}
      </div>

      {hasNextPage && (
        <div className="pt-3 text-center">
          <Button
            variant="outline"
            disabled={isFetchingNextPage}
            onClick={() => {
              void fetchNextPage();
            }}
          >
            {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  );
}
