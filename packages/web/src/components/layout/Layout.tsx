import { useState, useEffect } from 'react';
import { Outlet, NavLink } from 'react-router';
import { FolderGit2, LayoutDashboard, Workflow, Settings, X } from 'lucide-react';
import { TopNav } from './TopNav';
import { MobileNavContext } from '@/contexts/MobileNavContext';
import { useTheme } from '@/contexts/ThemeContext';
import { useVisualViewport } from '@/lib/useVisualViewport';
import { cn } from '@/lib/utils';

const navItems = [
  { to: '/chat', end: false, icon: FolderGit2, label: 'Projects' },
  { to: '/dashboard', end: true, icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/workflows', end: false, icon: Workflow, label: 'Workflows' },
] as const;

export function Layout(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const togglePin = (): void => {
    setPinned(p => !p);
  };
  const { compactLayout } = useTheme();
  // Fix 4: Escape key closes the mobile drawer
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return (): void => {
      document.removeEventListener('keydown', handler);
    };
  }, [open]);

  // Use the visual viewport height instead of h-dvh / h-screen so the layout
  // correctly shrinks when the soft keyboard appears on mobile (iOS Safari and
  // Chrome Android). This prevents the chat input from being hidden behind the
  // keyboard.
  const vpHeight = useVisualViewport();

  return (
    <MobileNavContext.Provider value={{ open, setOpen, pinned, togglePin }}>
      {/* Height is driven by visualViewport so it follows the keyboard on mobile */}
      <div
        className="flex flex-col bg-background overflow-hidden"
        style={{ height: `${vpHeight}px` }}
      >
        <TopNav />

        {/* ── Mobile nav overlay backdrop ── */}
        {open && (
          <div
            className={cn(
              'fixed inset-x-0 top-12 bottom-0 z-40 bg-black/60',
              compactLayout ? '' : 'md:hidden'
            )}
            onClick={() => {
              setOpen(false);
            }}
            aria-hidden="true"
          />
        )}

        {/* ── Mobile nav drawer ── */}
        <aside
          className={cn(
            'fixed top-12 bottom-0 left-0 z-50 flex w-72 flex-col border-r border-border shadow-2xl',
            'transition-transform duration-300 ease-in-out',
            compactLayout ? '' : 'md:hidden',
            open ? 'translate-x-0' : '-translate-x-full'
          )}
          style={{ backgroundColor: 'var(--surface)' }}
          role="dialog"
          aria-label="Mobile navigation"
          aria-modal="true"
        >
          {/* Drawer header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary">
                <span className="text-sm font-semibold text-primary-foreground">A</span>
              </div>
              <span className="text-sm font-semibold text-text-primary">Archon</span>
            </div>
            <button
              onClick={() => {
                setOpen(false);
              }}
              className="flex items-center justify-center rounded-md p-1.5 text-text-secondary hover:bg-surface-elevated hover:text-text-primary transition-colors"
              aria-label="Close menu"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Navigation links */}
          <nav className="flex-1 overflow-y-auto p-2 pt-3">
            {navItems.map(({ to, end, icon: Icon, label }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                onClick={() => {
                  setOpen(false);
                }}
                className={({ isActive }: { isActive: boolean }): string =>
                  cn(
                    'flex items-center gap-3 w-full rounded-md px-3 py-2.5 text-sm font-medium transition-colors mb-0.5',
                    isActive
                      ? 'bg-accent text-primary'
                      : 'text-text-secondary hover:bg-surface-elevated hover:text-text-primary'
                  )
                }
              >
                <Icon className="h-4 w-4 shrink-0" />
                {label}
              </NavLink>
            ))}
          </nav>

          {/* Settings — pinned at bottom */}
          <div className="p-2 border-t border-border">
            <NavLink
              to="/settings"
              onClick={() => {
                setOpen(false);
              }}
              className={({ isActive }: { isActive: boolean }): string =>
                cn(
                  'flex items-center gap-3 w-full rounded-md px-3 py-2.5 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-accent text-primary'
                    : 'text-text-secondary hover:bg-surface-elevated hover:text-text-primary'
                )
              }
            >
              <Settings className="h-4 w-4 shrink-0" />
              Settings
            </NavLink>
          </div>
        </aside>

        <main className="flex flex-1 flex-col overflow-hidden min-h-0">
          <Outlet />
        </main>
      </div>
    </MobileNavContext.Provider>
  );
}
