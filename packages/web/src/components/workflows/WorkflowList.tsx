import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search, X } from 'lucide-react';
import { listWorkflows } from '@/lib/api';
import type { WorkflowListEntry, WorkflowSource } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { WorkflowRow } from './WorkflowRow';

type SourceFilter = 'all' | WorkflowSource;

interface WorkflowListProps {
  cwd: string | undefined;
  selectedName: string | null;
  selectedSource: WorkflowSource | null;
  onSelect: (entry: WorkflowListEntry) => void;
  onNew: () => void;
}

export function WorkflowList({
  cwd,
  selectedName,
  selectedSource,
  onSelect,
  onNew,
}: WorkflowListProps): React.ReactElement {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SourceFilter>('all');

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['workflows', cwd ?? null],
    queryFn: () => listWorkflows(cwd),
    refetchOnWindowFocus: false,
  });

  const all: WorkflowListEntry[] = data ?? [];

  const counts = useMemo(() => {
    const c = { all: all.length, bundled: 0, global: 0, project: 0 };
    for (const e of all) {
      if (e.source === 'bundled') c.bundled += 1;
      else if (e.source === 'global') c.global += 1;
      else if (e.source === 'project') c.project += 1;
    }
    return c;
  }, [all]);

  const filtered = useMemo(() => {
    let list = all;
    if (filter !== 'all') list = list.filter(e => e.source === filter);
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter(
        e =>
          e.workflow.name.toLowerCase().includes(q) ||
          e.workflow.description.toLowerCase().includes(q)
      );
    }
    return [...list].sort((a, b) => a.workflow.name.localeCompare(b.workflow.name));
  }, [all, filter, query]);

  return (
    <div className="flex h-full w-[380px] shrink-0 flex-col border-r border-bridges-border-subtle bg-bridges-surface">
      <div className="flex flex-col gap-2.5 border-b border-bridges-border-subtle px-4 pt-3.5 pb-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[16px] font-semibold leading-tight text-bridges-fg1">
              Workflows
            </div>
            <div className="text-[12px] text-bridges-fg3">
              {filtered.length} of {all.length}
            </div>
          </div>
          <Button size="sm" onClick={onNew} className="h-8 gap-1.5 px-3 text-[12.5px]">
            <Plus className="h-3.5 w-3.5" />
            New workflow
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
            placeholder="Search workflows"
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
            label="Project"
            count={counts.project}
            active={filter === 'project'}
            onClick={() => {
              setFilter('project');
            }}
          />
          <FilterChip
            label="Global"
            count={counts.global}
            active={filter === 'global'}
            onClick={() => {
              setFilter('global');
            }}
          />
          <FilterChip
            label="Bundled"
            count={counts.bundled}
            active={filter === 'bundled'}
            onClick={() => {
              setFilter('bundled');
            }}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <div className="px-6 py-10 text-center text-[13px] text-bridges-fg3">
            Loading workflows…
          </div>
        )}
        {isError && (
          <div className="px-6 py-10 text-center text-[13px] text-bridges-tint-danger-fg">
            Failed to load workflows: {(error as Error | undefined)?.message}
          </div>
        )}
        {!isLoading && !isError && filtered.length === 0 && (
          <div className="px-6 py-10 text-center text-[13px] text-bridges-fg3">
            No workflows match your filters.
          </div>
        )}
        {filtered.map(e => (
          <WorkflowRow
            key={`${e.source}:${e.workflow.name}`}
            entry={e}
            selected={selectedName === e.workflow.name && selectedSource === e.source}
            onSelect={() => {
              onSelect(e);
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
