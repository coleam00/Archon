import { NavLink, Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { LayoutDashboard, MessageSquare, Workflow, Settings } from 'lucide-react';
import { listDashboardRuns, getUpdateCheck } from '@/lib/api';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

const tabs = [
  { to: '/chat', end: false, icon: MessageSquare, label: t('nav.chat') },
  { to: '/dashboard', end: true, icon: LayoutDashboard, label: t('nav.dashboard') },
  { to: '/workflows', end: false, icon: Workflow, label: t('nav.workflows') },
  { to: '/settings', end: false, icon: Settings, label: t('nav.settings') },
] as const;

export function TopNav(): React.ReactElement {
  // We only need `counts.running` — a server-side aggregate independent of
  // the `runs` array. `limit: 1` minimises the `runs` payload that the API
  // returns alongside the counts (we discard it).
  const { data: dashboardRuns } = useQuery({
    queryKey: ['dashboardRuns', { status: 'running', forCount: true }],
    queryFn: () => listDashboardRuns({ status: 'running', limit: 1 }),
    refetchInterval: 10_000,
  });
  const runningCount = dashboardRuns?.counts.running ?? 0;

  const { data: updateCheck } = useQuery({
    queryKey: ['update-check'],
    queryFn: getUpdateCheck,
    staleTime: 60 * 60 * 1000,
    refetchInterval: 60 * 60 * 1000,
    retry: false,
  });

  return (
    <nav className="flex items-center gap-1 border-b border-border bg-surface px-4">
      {/* Brand logo */}
      <Link to="/chat" className="flex items-center gap-2 mr-4 hover:opacity-80 transition-opacity">
        <img src="/favicon.png" alt="" className="h-7 w-7 shrink-0 object-contain" />
        <span className="text-sm font-semibold text-text-primary">HarneesLab</span>
      </Link>

      {tabs.map(({ to, end, icon: Icon, label }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }: { isActive: boolean }): string =>
            cn(
              'flex items-center gap-2 px-3 py-3 text-sm font-medium border-b-2 transition-colors',
              isActive
                ? 'border-primary text-primary'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            )
          }
        >
          <Icon className="h-4 w-4" />
          {label}
          {to === '/dashboard' && runningCount > 0 && (
            <span
              className="ml-1 inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground"
              aria-label={`${String(runningCount)}개 워크플로 실행 중`}
            >
              {runningCount}
            </span>
          )}
        </NavLink>
      ))}
      <span className="ml-auto text-xs text-text-secondary">
        v{import.meta.env.VITE_APP_VERSION as string}
        {updateCheck?.updateAvailable && updateCheck.releaseUrl && (
          <a
            href={updateCheck.releaseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-1.5 inline-flex items-center gap-1 text-xs text-primary hover:underline"
            title={`v${updateCheck.latestVersion} 사용 가능`}
          >
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />v
            {updateCheck.latestVersion}
          </a>
        )}
      </span>
    </nav>
  );
}
