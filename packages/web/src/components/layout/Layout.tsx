import { Outlet, useLocation } from 'react-router';
import { TabSummary } from '@/components/TabSummary';
import { getTabSummary } from '@/lib/tab-summaries';
import { TopNav } from './TopNav';
import { DeployStatusFooter } from './DeployStatusFooter';

const ROUTES_WITHOUT_TAB_SUMMARY = new Set([
  '/solutions',
  '/pmc',
  '/pmc-prospects',
  '/drive',
  '/brt',
]);

export function Layout(): React.ReactElement {
  const location = useLocation();
  const summary = ROUTES_WITHOUT_TAB_SUMMARY.has(location.pathname)
    ? undefined
    : getTabSummary(location.pathname);

  return (
    <div className="flex h-screen min-h-0 flex-col bg-background">
      <TopNav />
      {/* Seamless blend strip between navy nav and ivory canvas */}
      <div className="pmc-nav-blend shrink-0" aria-hidden="true" />
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {summary && (
          <div className="shrink-0 border-b border-border bg-[oklch(0.985_0.012_88)] px-6 py-4">
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
        <div id="dashboard-tab-content" className="min-h-0 flex-1 overflow-auto scroll-mt-4">
          <Outlet />
        </div>
      </main>
      <div className="shrink-0">
        <DeployStatusFooter />
      </div>
    </div>
  );
}
