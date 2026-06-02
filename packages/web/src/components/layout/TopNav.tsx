import { NavLink, Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  LayoutDashboard,
  MessageSquare,
  Workflow,
  Settings,
  Volume2,
  BarChart2,
  PenLine,
  Globe,
  Activity,
  ClipboardList,
  Share2,
  Briefcase,
  Mail,
  FlaskConical,
  Wrench,
  CheckSquare,
  Users,
  HardDrive,
} from 'lucide-react';
import { listDashboardRuns, getUpdateCheck } from '@/lib/api';
import { cn } from '@/lib/utils';

const tabs = [
  { to: '/chat', end: false, icon: MessageSquare, label: 'Chat' },
  { to: '/dashboard', end: true, icon: LayoutDashboard, label: 'Dashboard' },
  // Categories — operating-lens nav (per 2026-05-07 consultant review)
  { to: '/category/writing-comms', end: false, icon: Mail, label: 'Writing' },
  { to: '/category/research-learning', end: false, icon: FlaskConical, label: 'Research' },
  { to: '/category/techbase', end: false, icon: Wrench, label: 'Techbase' },
  { to: '/category/work-daily-ops', end: false, icon: CheckSquare, label: 'Daily Ops' },
  { to: '/contacts', end: false, icon: Users, label: 'Contacts' },
  { to: '/drive', end: false, icon: HardDrive, label: 'Drive' },
  // Brand tabs (drill-down per business)
  { to: '/pmc', end: false, icon: Briefcase, label: 'PMC' },
  { to: '/workflows', end: false, icon: Workflow, label: 'Workflows' },
  { to: '/settings', end: false, icon: Settings, label: 'Settings' },
  { to: '/tts', end: false, icon: Volume2, label: 'TTS' },
  { to: '/brt', end: false, icon: BarChart2, label: 'BRT' },
  { to: '/sg-ink', end: false, icon: PenLine, label: 'SG INK' },
  { to: '/naba', end: false, icon: Globe, label: 'NABA' },
  { to: '/ihht', end: false, icon: Activity, label: 'IHHT' },
  { to: '/qep', end: false, icon: ClipboardList, label: 'QEP' },
  { to: '/social-content', end: false, icon: Share2, label: 'Social Content' },
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
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary">
          <span className="text-sm font-semibold text-primary-foreground">P</span>
        </div>
        <span
          className="text-sm font-semibold text-text-primary"
          style={{ fontFamily: "'Playfair Display', serif" }}
        >
          PMC
        </span>
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
              aria-label={`${runningCount} workflows running`}
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
            title={`v${updateCheck.latestVersion} available`}
          >
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />v
            {updateCheck.latestVersion}
          </a>
        )}
      </span>
    </nav>
  );
}
