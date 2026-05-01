import { useQuery } from '@tanstack/react-query';
import { listDashboardRuns } from '@/lib/api';
import { cn } from '@/lib/utils';

interface MissionStatusBarProps {
  onJumpToApprovals: () => void;
}

export function MissionStatusBar({ onJumpToApprovals }: MissionStatusBarProps): React.ReactElement {
  // limit:1 — we only need the counts aggregate, not the runs.
  const { data } = useQuery({
    queryKey: ['mission.statusBar.counts'],
    queryFn: () => listDashboardRuns({ limit: 1 }),
    refetchInterval: 10_000,
  });
  const counts = data?.counts;
  // Paused = waiting on the operator. In practice approval gates are the only
  // reason a run pauses, so use `counts.paused` directly. If we add other
  // pause causes later, narrow this to a separate query.
  const needsMeCount = counts?.paused ?? 0;

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2 text-xs">
      <Pill label="Running" value={counts?.running ?? 0} tone="info" />
      <Pill label="Paused" value={counts?.paused ?? 0} tone="warn" />
      <Pill label="Failed" value={counts?.failed ?? 0} tone="error" />
      <Pill label="Pending" value={counts?.pending ?? 0} tone="muted" />
      <span className="ml-auto" />
      <button
        type="button"
        onClick={onJumpToApprovals}
        disabled={needsMeCount === 0}
        className={cn(
          'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
          needsMeCount > 0
            ? 'border-warning/40 bg-warning/10 text-warning hover:bg-warning/20 animate-pulse'
            : 'border-border bg-surface text-text-tertiary cursor-default'
        )}
      >
        {needsMeCount > 0 ? `Needs me · ${String(needsMeCount)}` : 'Nothing waiting on you'}
      </button>
    </div>
  );
}

function Pill({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'info' | 'warn' | 'error' | 'muted';
}): React.ReactElement {
  const toneClass = {
    info: 'border-primary/30 bg-primary/5 text-primary',
    warn: 'border-warning/30 bg-warning/5 text-warning',
    error: 'border-error/30 bg-error/5 text-error',
    muted: 'border-border bg-surface text-text-secondary',
  }[tone];
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-md border px-2 py-1', toneClass)}>
      <span className="font-medium">{value}</span>
      <span className="uppercase tracking-wide text-[10px] opacity-80">{label}</span>
    </span>
  );
}
