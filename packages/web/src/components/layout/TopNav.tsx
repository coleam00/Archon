import { NavLink, Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { LayoutDashboard, FolderGit2, Workflow, Settings, Menu, Sun, Moon } from 'lucide-react';
import { listWorkflowRuns, getUpdateCheck } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useMobileNav } from '@/contexts/MobileNavContext';
import { TunnelPopover } from './TunnelPopover';
import { useTheme } from '@/contexts/ThemeContext';

const tabs = [
  { to: '/chat', end: false, icon: FolderGit2, label: 'Projects' },
  { to: '/dashboard', end: true, icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/workflows', end: false, icon: Workflow, label: 'Workflows' },
  { to: '/settings', end: false, icon: Settings, label: 'Settings' },
] as const;

const isSafeUrl = (url: string): boolean => /^https?:\/\//i.test(url);
export function TopNav(): React.ReactElement {
  const { setOpen } = useMobileNav();
  const { theme, toggleTheme } = useTheme();

  const { data: runningRuns } = useQuery({
    queryKey: ['workflowRuns', { status: 'running' }],
    queryFn: () => listWorkflowRuns({ status: 'running', limit: 1 }),
    refetchInterval: 10_000,
  });
  const hasRunning = (runningRuns?.length ?? 0) > 0;

  const { data: updateCheck } = useQuery({
    queryKey: ['update-check'],
    queryFn: getUpdateCheck,
    staleTime: 60 * 60 * 1000,
    refetchInterval: 60 * 60 * 1000,
    retry: false,
  });

  return (
    <nav className="flex items-center gap-1 border-b border-border bg-surface px-4">
      {/* ── Mobile: hamburger button (hidden on desktop) ── */}
      <button
        onClick={() => {
          setOpen(true);
        }}
        className="flex items-center justify-center rounded-md p-1.5 mr-2 text-text-secondary hover:bg-surface-elevated hover:text-text-primary transition-colors md:hidden"
        aria-label="Open menu"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Brand logo */}
      <Link to="/chat" className="flex items-center gap-2 mr-4 hover:opacity-80 transition-opacity">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary">
          <span className="text-sm font-semibold text-primary-foreground">A</span>
        </div>
        {/* Logo text: always visible */}
        <span className="text-sm font-semibold text-text-primary">Archon</span>
      </Link>

      {/* ── Desktop nav tabs (hidden on mobile) ── */}
      <div className="hidden md:flex items-center gap-1">
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
            {to === '/dashboard' && hasRunning && (
              <span className="flex h-2 w-2 rounded-full bg-primary animate-pulse" />
            )}
          </NavLink>
        ))}
      </div>

      {/* Version + update badge */}
      <span className="ml-auto text-xs text-text-secondary">
        v{(import.meta.env.VITE_APP_VERSION as string | undefined) ?? 'dev'}
        {updateCheck?.updateAvailable && updateCheck.releaseUrl && isSafeUrl(updateCheck.releaseUrl) && (
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

      {/* ── Tunnel popover ── */}
      <TunnelPopover />

      {/* ── Theme toggle ── */}
      <button
        onClick={toggleTheme}
        aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        className="ml-2 p-2 rounded-md text-text-secondary hover:bg-surface-elevated hover:text-text-primary transition-colors"
      >
        {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
      </button>
    </nav>
  );
}
