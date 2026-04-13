import { useState } from 'react';
import { Outlet, NavLink } from 'react-router';
import { MessageSquare, LayoutDashboard, Workflow, Settings, X } from 'lucide-react';
import { TopNav } from './TopNav';
import { MobileNavContext } from '@/contexts/MobileNavContext';
import { cn } from '@/lib/utils';

const navItems = [
  { to: '/chat', end: false, icon: MessageSquare, label: 'Chat' },
  { to: '/dashboard', end: true, icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/workflows', end: false, icon: Workflow, label: 'Workflows' },
] as const;

export function Layout(): React.ReactElement {
  const [open, setOpen] = useState(false);

  return (
    <MobileNavContext.Provider value={{ open, setOpen }}>
      {/* h-dvh (100dvh) instead of h-screen (100vh) so the layout height follows the
          dynamic viewport on mobile — shrinks when the browser address bar is visible,
          keeping the chat input always reachable without scrolling. */}
      <div className="flex h-dvh flex-col bg-background">
        <TopNav />

        {/* ── Mobile nav overlay backdrop ── */}
        {open && (
          <div
            className="fixed inset-0 z-40 bg-black/60 md:hidden"
            onClick={() => { setOpen(false); }}
            aria-hidden="true"
          />
        )}

        {/* ── Mobile nav drawer ── */}
        <aside
          className={cn(
            'fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-surface border-r border-border shadow-2xl',
            'transition-transform duration-300 ease-in-out',
            'md:hidden',
            open ? 'translate-x-0' : '-translate-x-full'
          )}
          aria-label="Navigation mobile"
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
              onClick={() => { setOpen(false); }}
              className="flex items-center justify-center rounded-md p-1.5 text-text-secondary hover:bg-surface-elevated hover:text-text-primary transition-colors"
              aria-label="Fermer le menu"
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
                onClick={() => { setOpen(false); }}
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
              onClick={() => { setOpen(false); }}
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

        <main className="flex flex-1 flex-col overflow-hidden">
          <Outlet />
        </main>
      </div>
    </MobileNavContext.Provider>
  );
}
