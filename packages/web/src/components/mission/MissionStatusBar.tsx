import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, ArrowRight } from 'lucide-react';
import { listDashboardRuns } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Kbd } from './primitives';

interface MissionStatusBarProps {
  onJumpToApprovals: () => void;
}

type Range = '1h' | '24h' | '7d' | '30d';
const RANGES: Range[] = ['1h', '24h', '7d', '30d'];

export function MissionStatusBar({ onJumpToApprovals }: MissionStatusBarProps): React.ReactElement {
  const { data } = useQuery({
    queryKey: ['mission.statusBar.counts'],
    queryFn: () => listDashboardRuns({ limit: 1 }),
    refetchInterval: 10_000,
  });
  const counts = data?.counts;
  const needsMeCount = counts?.paused ?? 0;

  const [range, setRange] = useState<Range>('24h');
  const [search, setSearch] = useState('');

  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2.5 border-b border-bridges-border-subtle bg-bridges-bg px-6 py-3">
      <Counter label="Running" value={counts?.running ?? 0} dot="#F59E0B" />
      <Counter label="Failed" value={counts?.failed ?? 0} dot="#EF4444" />
      <Counter label="Completed" value={counts?.completed ?? 0} dot="#10B981" />
      <Counter label="Pending" value={counts?.pending ?? 0} dot="#71717A" ring />

      {needsMeCount > 0 && (
        <button
          type="button"
          onClick={onJumpToApprovals}
          className="inline-flex items-center gap-2 rounded-full border border-[#C4B5FD] bg-[#EDE9FE] px-2.5 py-[5px] text-[12px] font-semibold text-[#5B21B6]"
          style={{ animation: 'needs-me-pulse 2.4s ease-in-out infinite' }}
        >
          <span className="h-2 w-2 rounded-full bg-bridges-trigger" />
          Needs you
          <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-bridges-trigger px-1.5 text-[11px] font-semibold leading-none text-white">
            {needsMeCount}
          </span>
          <ArrowRight className="h-3 w-3" />
        </button>
      )}

      <div className="flex-1" />

      <div className="inline-flex rounded-md bg-bridges-surface-muted p-0.5">
        {RANGES.map(r => (
          <button
            key={r}
            type="button"
            onClick={() => {
              setRange(r);
            }}
            className={cn(
              'rounded px-2.5 py-[3px] text-[11.5px] font-medium transition-colors',
              range === r
                ? 'bg-bridges-surface text-bridges-fg1 shadow-[0_1px_2px_rgba(15,15,18,0.06)]'
                : 'text-bridges-fg2 hover:text-bridges-fg1'
            )}
          >
            {r}
          </button>
        ))}
      </div>

      <div className="flex w-[320px] items-center gap-2 rounded-md border border-bridges-border bg-bridges-surface px-2.5 py-[5px] text-[13px] text-bridges-fg1">
        <Search className="h-3.5 w-3.5 text-bridges-fg3" />
        <input
          value={search}
          onChange={e => {
            setSearch(e.target.value);
          }}
          placeholder="Search runs, ARC-… , file paths"
          className="min-w-0 flex-1 border-none bg-transparent text-[13px] text-bridges-fg1 outline-none placeholder:text-bridges-fg-placeholder"
        />
        <Kbd>⌘K</Kbd>
      </div>
    </div>
  );
}

function Counter({
  label,
  value,
  dot,
  ring = false,
  accent,
}: {
  label: string;
  value: number;
  dot: string;
  ring?: boolean;
  accent?: string;
}): React.ReactElement {
  return (
    <div className="inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-bridges-border bg-bridges-surface py-[5px] pl-2.5 pr-3">
      <span
        className="h-2 w-2 rounded-full"
        style={{
          background: ring ? 'transparent' : dot,
          border: ring ? `1.5px solid ${dot}` : 'none',
        }}
      />
      <span className="text-[12px] text-bridges-fg2">{label}</span>
      <span
        className="text-[12px] font-semibold tabular-nums"
        style={{ color: accent ?? 'var(--bridges-fg1)' }}
      >
        {value}
      </span>
    </div>
  );
}
