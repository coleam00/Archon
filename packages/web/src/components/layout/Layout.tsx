import { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router';
import { TabSummary } from '@/components/TabSummary';
import { getTabSummary } from '@/lib/tab-summaries';
import { TopNav } from './TopNav';
import { DeployStatusFooter } from './DeployStatusFooter';

export function Layout(): React.ReactElement {
  const location = useLocation();
  const summary = getTabSummary(location.pathname);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isContextHidden, setIsContextHidden] = useState(false);

  useEffect(() => {
    const contentEl = contentRef.current;
    if (!contentEl) {
      return undefined;
    }

    setIsContextHidden(false);
    contentEl.scrollTo({ top: 0 });

    const handleScroll = (event: Event): void => {
      const scrollTarget = event.target instanceof HTMLElement ? event.target : contentEl;
      setIsContextHidden(Math.max(contentEl.scrollTop, scrollTarget.scrollTop) > 24);
    };

    contentEl.addEventListener('scroll', handleScroll, { capture: true, passive: true });
    handleScroll(new Event('scroll'));

    return (): void => {
      contentEl.removeEventListener('scroll', handleScroll, { capture: true });
    };
  }, [location.pathname]);

  const handleContentScrollCapture = (event: React.UIEvent<HTMLDivElement>): void => {
    const contentEl = contentRef.current;
    const scrollTarget = event.target instanceof HTMLElement ? event.target : contentEl;
    setIsContextHidden(Math.max(contentEl?.scrollTop ?? 0, scrollTarget?.scrollTop ?? 0) > 24);
  };

  return (
    <div className="flex h-screen min-h-0 flex-col bg-background">
      <TopNav />
      {/* Seamless blend strip between navy nav and ivory canvas */}
      <div className="pmc-nav-blend shrink-0" aria-hidden="true" />
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {summary && (
          <div
            className={`shrink-0 overflow-hidden border-b bg-[oklch(0.985_0.012_88)] px-6 transition-[max-height,opacity,padding,border-color] duration-300 ease-out ${
              isContextHidden
                ? 'max-h-0 border-transparent py-0 opacity-0'
                : 'max-h-96 border-border py-4 opacity-100'
            }`}
          >
            <div className="mx-auto max-w-7xl">
              <TabSummary
                title={summary.title}
                purpose={summary.purpose}
                status={summary.status}
                focus={summary.focus}
                blockers={summary.blockers}
                refreshed={summary.refreshed}
                vaultPath={summary.vaultPath}
              />
            </div>
          </div>
        )}
        <div
          ref={contentRef}
          id="dashboard-tab-content"
          onScrollCapture={handleContentScrollCapture}
          className="min-h-0 flex-1 overflow-auto scroll-mt-4"
        >
          <Outlet />
        </div>
      </main>
      <div className="shrink-0">
        <DeployStatusFooter />
      </div>
    </div>
  );
}
