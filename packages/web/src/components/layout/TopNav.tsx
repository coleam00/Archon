import { useState, useRef, useEffect } from 'react';
import { NavLink, Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { LayoutDashboard, Workflow, Settings, Menu, Sun, Moon, ChevronRight } from 'lucide-react';
import { listWorkflowRuns, getUpdateCheck } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useMobileNav } from '@/contexts/MobileNavContext';
import { TunnelPopover } from './TunnelPopover';
import { useTheme } from '@/contexts/ThemeContext';

const secondaryNav = [
  { to: '/dashboard', end: true as const, icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/workflows', end: false as const, icon: Workflow, label: 'Workflows' },
  { to: '/settings', end: false as const, icon: Settings, label: 'Settings' },
];

const isSafeUrl = (url: string): boolean => /^https?:\/\//i.test(url);

export function TopNav(): React.ReactElement {
  const { setOpen, pinned } = useMobileNav();
  const { theme, toggleTheme } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return (): void => {
      document.removeEventListener('mousedown', handler);
    };
  }, [menuOpen]);

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

  // Sidebar is visually "closed" when unpinned (mobile always, desktop when unpinned)
  const sidebarClosed = !pinned;

  return (
    <nav className="flex items-center gap-1 border-b border-border bg-surface px-4">
      {/* ── Logo / sidebar-toggle ──
          When sidebar is closed: clicking opens it (shows ChevronRight hint).
          When sidebar is open/pinned on desktop: acts as a plain link to /chat. ── */}
      {sidebarClosed ? (
        <button
          onClick={() => {
            setOpen(true);
          }}
          className="flex items-center gap-2 mr-4 hover:opacity-80 transition-opacity group"
          aria-label="Open sidebar"
        >
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary">
            <span className="text-sm font-semibold text-primary-foreground">A</span>
          </div>
          <span className="text-sm font-semibold text-text-primary">Archon</span>
          <ChevronRight className="h-3.5 w-3.5 text-text-secondary opacity-60 group-hover:opacity-100 transition-opacity" />
        </button>
      ) : (
        <Link
          to="/chat"
          className="flex items-center gap-2 mr-4 hover:opacity-80 transition-opacity"
        >
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary">
            <span className="text-sm font-semibold text-primary-foreground">A</span>
          </div>
          <span className="text-sm font-semibold text-text-primary">Archon</span>
        </Link>
      )}

      {/* Version + update badge */}
      <span className="ml-auto text-xs text-text-secondary">
        v{(import.meta.env.VITE_APP_VERSION as string | undefined) ?? 'dev'}
        {updateCheck?.updateAvailable &&
          updateCheck.releaseUrl &&
          isSafeUrl(updateCheck.releaseUrl) && (
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

      {/* ── Secondary nav dropdown (Dashboard / Workflows / Settings) ── */}
      <div ref={menuRef} className="relative ml-1">
        <button
          onClick={() => {
            setMenuOpen(prev => !prev);
          }}
          className={cn(
            'flex items-center justify-center rounded-md p-1.5 text-text-secondary',
            'hover:bg-surface-elevated hover:text-text-primary transition-colors',
            menuOpen && 'bg-surface-elevated text-text-primary'
          )}
          aria-label="Open navigation menu"
          aria-expanded={menuOpen}
        >
          <Menu className="h-5 w-5" />
        </button>

        {menuOpen && (
          <div className="absolute right-0 top-full mt-1 z-50 w-48 rounded-md border border-border bg-surface shadow-lg py-1">
            {secondaryNav.map(({ to, end, icon: Icon, label }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                onClick={() => {
                  setMenuOpen(false);
                }}
                className={({ isActive }: { isActive: boolean }): string =>
                  cn(
                    'flex items-center gap-2 px-3 py-2 text-sm transition-colors',
                    isActive
                      ? 'text-primary bg-surface-elevated'
                      : 'text-text-secondary hover:text-text-primary hover:bg-surface-elevated'
                  )
                }
              >
                <Icon className="h-4 w-4" />
                {label}
                {to === '/dashboard' && hasRunning && (
                  <span className="flex h-2 w-2 rounded-full bg-primary animate-pulse ml-auto" />
                )}
              </NavLink>
            ))}
          </div>
        )}
      </div>
    </nav>
  );
}
