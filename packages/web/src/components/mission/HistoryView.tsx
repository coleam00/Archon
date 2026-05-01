import { useState, useMemo } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { listDashboardRuns, listCodebases } from '@/lib/api';
import type { DashboardRunResponse, DashboardRunsResult } from '@/lib/api';
import type { WorkflowRunStatus } from '@/lib/types';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

const STATUS_OPTIONS: WorkflowRunStatus[] = [
  'running',
  'completed',
  'failed',
  'cancelled',
  'paused',
  'pending',
];

interface Filters {
  status: WorkflowRunStatus | '';
  codebaseId: string;
  errorClass: string;
  search: string;
}

const EMPTY_FILTERS: Filters = { status: '', codebaseId: '', errorClass: '', search: '' };

interface HistoryViewProps {
  onOpenRun: (runId: string) => void;
}

export function HistoryView({ onOpenRun }: HistoryViewProps): React.ReactElement {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);

  const { data: codebases } = useQuery({
    queryKey: ['mission.codebases'],
    queryFn: listCodebases,
  });

  // useInfiniteQuery with cursor pagination. Each page returns nextCursor;
  // we stop fetching when nextCursor is null.
  const queryKey = useMemo(() => ['missionHistory', filters] as const, [filters]);
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery<DashboardRunsResult>({
      queryKey,
      initialPageParam: undefined as string | undefined,
      queryFn: ({ pageParam }) =>
        listDashboardRuns({
          status: filters.status || undefined,
          codebaseId: filters.codebaseId || undefined,
          errorClass: filters.errorClass || undefined,
          search: filters.search || undefined,
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

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-4">
        <select
          aria-label="Filter by status"
          value={filters.status}
          onChange={e => {
            setFilters(f => ({ ...f, status: e.target.value as Filters['status'] }));
          }}
          className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text-primary"
        >
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map(s => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by codebase"
          value={filters.codebaseId}
          onChange={e => {
            setFilters(f => ({ ...f, codebaseId: e.target.value }));
          }}
          className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text-primary"
        >
          <option value="">All codebases</option>
          {codebases?.map(cb => (
            <option key={cb.id} value={cb.id}>
              {cb.name}
            </option>
          ))}
        </select>
        <Input
          placeholder="Error class"
          value={filters.errorClass}
          onChange={e => {
            setFilters(f => ({ ...f, errorClass: e.target.value }));
          }}
        />
        <Input
          placeholder="Search workflow / message"
          value={filters.search}
          onChange={e => {
            setFilters(f => ({ ...f, search: e.target.value }));
          }}
        />
      </div>

      {isLoading && <p className="text-sm text-text-secondary">Loading…</p>}
      {!isLoading && rows.length === 0 && (
        <p className="text-sm text-text-secondary">No runs match the current filters.</p>
      )}

      <ul className="space-y-2">
        {rows.map(run => (
          <HistoryRow key={run.id} run={run} onOpen={onOpenRun} />
        ))}
      </ul>

      {hasNextPage && (
        <div className="pt-2 text-center">
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

function HistoryRow({
  run,
  onOpen,
}: {
  run: DashboardRunResponse;
  onOpen: (runId: string) => void;
}): React.ReactElement {
  return (
    <li className="rounded-md border border-border bg-surface-elevated px-3 py-2 text-sm">
      <button
        type="button"
        onClick={() => {
          onOpen(run.id);
        }}
        className="flex w-full flex-col gap-1 text-left sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-text-primary">{run.workflow_name}</p>
          <p className="truncate text-xs text-text-secondary">
            {run.codebase_name ?? '—'} ·{' '}
            {run.started_at ? new Date(run.started_at).toLocaleString() : '—'}
          </p>
        </div>
        <span className="text-xs uppercase tracking-wide text-text-secondary">{run.status}</span>
      </button>
    </li>
  );
}
