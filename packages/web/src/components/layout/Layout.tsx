import { useState, useEffect, useCallback } from 'react';
import { Outlet } from 'react-router';
import { X, Pin, PinOff } from 'lucide-react';
import { TopNav } from './TopNav';
import { ProjectsSidebar } from '@/components/sidebar/ProjectsSidebar';
import { MobileNavContext } from '@/contexts/MobileNavContext';
import { useTheme } from '@/contexts/ThemeContext';
import { useVisualViewport } from '@/lib/useVisualViewport';
import { cn } from '@/lib/utils';

const SIDEBAR_PINNED_KEY = 'archon-sidebar-pinned';
const DESKTOP_BREAKPOINT = 768;

function getIsDesktop(): boolean {
  return window.innerWidth >= DESKTOP_BREAKPOINT;
}

function getInitialPinned(): boolean {
  if (!getIsDesktop()) return false;
  const stored = localStorage.getItem(SIDEBAR_PINNED_KEY);
  return stored === null ? true : stored === 'true';
}

export function Layout(): React.ReactElement {
  const { compactLayout } = useTheme();

  // pinned = sidebar locked open as a static column (desktop/tablet only)
  const [pinned, setPinned] = useState<boolean>(getInitialPinned);

  // open = drawer/overlay sidebar is shown (mobile always, desktop when unpinned)
  const [open, setOpen] = useState<boolean>(false);

  // isDesktop tracks viewport reactively so the layout adapts on resize
  const [isDesktop, setIsDesktop] = useState<boolean>(getIsDesktop);

  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${DESKTOP_BREAKPOINT}px)`);
    const handler = (e: MediaQueryListEvent): void => {
      setIsDesktop(e.matches);
      if (!e.matches) {
        // Entering mobile: always close the drawer
        setOpen(false);
      }
    };
    mq.addEventListener('change', handler);
    return (): void => {
      mq.removeEventListener('change', handler);
    };
  }, []);

  const togglePin = useCallback((): void => {
    setPinned(prev => {
      const next = !prev;
      localStorage.setItem(SIDEBAR_PINNED_KEY, String(next));
      if (!next) setOpen(false);
      return next;
    });
  }, []);

  // Escape key closes the drawer
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

  // After navigation: close drawer on mobile or when unpinned on desktop
  const handleNavigate = useCallback((): void => {
    if (!isDesktop || !pinned) {
      setOpen(false);
    }
  }, [isDesktop, pinned]);

  // Desktop + pinned: sidebar is a static column (no overlay needed)
  const showStaticSidebar = !compactLayout && isDesktop && pinned;
  // Show overlay drawer: mobile, or desktop+unpinned when open
  const showOverlay = open && !showStaticSidebar;

  const vpHeight = useVisualViewport();

  return (
    <MobileNavContext.Provider value={{ open, setOpen, pinned, togglePin }}>
      <div
        className="flex flex-col bg-background overflow-hidden"
        style={{ height: `${vpHeight}px` }}
      >
        <TopNav />

        <div className="flex flex-1 overflow-hidden min-h-0">
          {/* ── Static sidebar: desktop + pinned ── */}
          {showStaticSidebar && (
            <aside
              className="flex flex-col w-72 border-r border-border shrink-0"
              style={{ backgroundColor: 'var(--surface)' }}
              aria-label="Projects sidebar"
            >
              {/* Header with pin button */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
                <div className="flex items-center gap-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary">
                    <span className="text-sm font-semibold text-primary-foreground">A</span>
                  </div>
                  <span className="text-sm font-semibold text-text-primary">Archon</span>
                </div>
                <button
                  onClick={togglePin}
                  className="flex items-center justify-center rounded-md p-1.5 text-text-secondary hover:bg-surface-elevated hover:text-text-primary transition-colors"
                  aria-label="Unpin sidebar"
                  title="Unpin sidebar"
                >
                  <PinOff className="h-4 w-4" />
                </button>
              </div>
              <div className="flex flex-1 flex-col overflow-hidden min-h-0">
                <ProjectsSidebar searchQuery="" onNavigate={handleNavigate} />
              </div>
            </aside>
          )}

          {/* ── Overlay backdrop ── */}
          {showOverlay && (
            <div
              className="fixed inset-x-0 top-12 bottom-0 z-40 bg-black/60"
              onClick={() => {
                setOpen(false);
              }}
              aria-hidden="true"
            />
          )}

          {/* ── Overlay/drawer sidebar: mobile or desktop+unpinned ── */}
          {!showStaticSidebar && (
            <aside
              className={cn(
                'fixed top-12 bottom-0 left-0 z-50 flex w-72 flex-col border-r border-border shadow-2xl',
                'transition-transform duration-300 ease-in-out',
                open ? 'translate-x-0' : '-translate-x-full'
              )}
              style={{ backgroundColor: 'var(--surface)' }}
              aria-label="Projects sidebar"
              aria-modal="true"
            >
              {/* Drawer header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
                <div className="flex items-center gap-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary">
                    <span className="text-sm font-semibold text-primary-foreground">A</span>
                  </div>
                  <span className="text-sm font-semibold text-text-primary">Archon</span>
                </div>
                <div className="flex items-center gap-1">
                  {/* Pin button: only visible on desktop */}
                  {isDesktop && (
                    <button
                      onClick={togglePin}
                      className="flex items-center justify-center rounded-md p-1.5 text-text-secondary hover:bg-surface-elevated hover:text-text-primary transition-colors"
                      aria-label="Pin sidebar"
                      title="Pin sidebar open"
                    >
                      <Pin className="h-4 w-4" />
                    </button>
                  )}
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
              </div>

              <div className="flex flex-1 flex-col overflow-hidden min-h-0">
                <ProjectsSidebar searchQuery="" onNavigate={handleNavigate} />
              </div>
            </aside>
          )}

          <main className="flex flex-1 flex-col overflow-hidden min-h-0">
            <Outlet />
          </main>
        </div>
      </div>
    </MobileNavContext.Provider>
  );
}
