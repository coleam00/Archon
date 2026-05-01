import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search, X } from 'lucide-react';
import { listAgents, type AgentSummary } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { AgentRow } from './AgentRow';

type StatusFilter = 'all' | 'active' | 'draft' | 'archived';
type SortMode = 'edited' | 'name';

interface AgentListProps {
  cwd: string | undefined;
  selectedName: string | null;
  selectedSource: 'global' | 'project' | null;
  onSelect: (agent: AgentSummary) => void;
  onCreate: () => void;
}

export function AgentList({
  cwd,
  selectedName,
  selectedSource,
  onSelect,
  onCreate,
}: AgentListProps): React.ReactElement {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [sort, setSort] = useState<SortMode>('edited');

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['agents', cwd ?? null],
    queryFn: () => listAgents(cwd),
    refetchOnWindowFocus: false,
  });

  const all = data?.agents ?? [];
  const counts = useMemo(() => {
    const c = { all: all.length, active: 0, draft: 0, archived: 0 };
    for (const a of all) c[a.status] += 1;
    return c;
  }, [all]);

  const filtered = useMemo(() => {
    let list = all;
    if (filter !== 'all') list = list.filter(a => a.status === filter);
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter(
        a => a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q)
      );
    }
    list = [...list];
    if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
    else list.sort((a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : 0));
    return list;
  }, [all, filter, query, sort]);

  return (
    <div className="flex h-full w-[380px] shrink-0 flex-col border-r border-bridges-border-subtle bg-bridges-surface">
      <div className="flex flex-col gap-2.5 border-b border-bridges-border-subtle px-4 pt-3.5 pb-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[16px] font-semibold leading-tight text-bridges-fg1">Agents</div>
            <div className="text-[12px] text-bridges-fg3">
              {filtered.length} of {all.length}
            </div>
          </div>
          <Button size="sm" onClick={onCreate} className="h-8 gap-1.5 px-3 text-[12.5px]">
            <Plus className="h-3.5 w-3.5" />
            New agent
          </Button>
        </div>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-bridges-fg3" />
          <input
            type="text"
            value={query}
            onChange={e => {
              setQuery(e.target.value);
            }}
            placeholder="Search agents"
            className="w-full rounded-md border border-bridges-border bg-bridges-surface py-1.5 pl-8 pr-7 text-[13px] text-bridges-fg1 placeholder:text-bridges-fg-placeholder focus:border-bridges-border-strong focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery('');
              }}
              className="absolute right-2 top-1/2 inline-flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded text-bridges-fg3 hover:bg-bridges-surface-muted"
              aria-label="Clear search"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        <div className="flex flex-wrap gap-1.5">
          <FilterChip
            label="All"
            count={counts.all}
            active={filter === 'all'}
            onClick={() => {
              setFilter('all');
            }}
          />
          <FilterChip
            label="Active"
            count={counts.active}
            active={filter === 'active'}
            onClick={() => {
              setFilter('active');
            }}
          />
          <FilterChip
            label="Draft"
            count={counts.draft}
            active={filter === 'draft'}
            onClick={() => {
              setFilter('draft');
            }}
          />
          <FilterChip
            label="Archived"
            count={counts.archived}
            active={filter === 'archived'}
            onClick={() => {
              setFilter('archived');
            }}
          />
        </div>

        <div className="flex items-center justify-between text-[12px] text-bridges-fg3">
          <span>Sort</span>
          <div className="flex gap-0.5">
            <SortTab
              label="Edited"
              active={sort === 'edited'}
              onClick={() => {
                setSort('edited');
              }}
            />
            <SortTab
              label="Name"
              active={sort === 'name'}
              onClick={() => {
                setSort('name');
              }}
            />
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <div className="px-6 py-10 text-center text-[13px] text-bridges-fg3">Loading agents…</div>
        )}
        {isError && (
          <div className="px-6 py-10 text-center text-[13px] text-bridges-tint-danger-fg">
            Failed to load agents: {(error as Error | undefined)?.message}
          </div>
        )}
        {!isLoading && !isError && filtered.length === 0 && (
          <div className="px-6 py-10 text-center text-[13px] text-bridges-fg3">
            No agents match your filters.
          </div>
        )}
        {filtered.map(a => (
          <AgentRow
            key={`${a.source}:${a.name}`}
            agent={a}
            selected={selectedName === a.name && selectedSource === a.source}
            onSelect={() => {
              onSelect(a);
            }}
          />
        ))}
      </div>
    </div>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-6 items-center gap-1 rounded-full border px-2.5 text-[11.5px] font-medium leading-none transition-colors',
        active
          ? 'border-bridges-action bg-bridges-action text-white'
          : 'border-bridges-border bg-bridges-surface text-bridges-fg2 hover:border-bridges-border-strong'
      )}
    >
      {label}
      <span className="font-mono opacity-70">{count}</span>
    </button>
  );
}

function SortTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded px-2 py-0.5 text-[12px] font-medium transition-colors',
        active
          ? 'bg-bridges-surface-muted text-bridges-fg1'
          : 'text-bridges-fg2 hover:bg-bridges-surface-subtle'
      )}
    >
      {label}
    </button>
  );
}
