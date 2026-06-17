import { Outlet, useLocation } from 'react-router';
import { TabSummary } from '@/components/TabSummary';
import { getTabSummary } from '@/lib/tab-summaries';
import { TopNav } from './TopNav';
import { DeployStatusFooter } from './DeployStatusFooter';

export function Layout(): React.ReactElement {
  const location = useLocation();
  const summary = getTabSummary(location.pathname);

  return (
    <div className="flex h-screen flex-col bg-background">
      <TopNav />
      {/* Seamless blend strip between navy nav and ivory canvas */}
      <div className="pmc-nav-blend" aria-hidden="true" />
      <main className="flex flex-1 flex-col overflow-hidden">
        {summary && (
          <div className="border-b border-border bg-[oklch(0.985_0.012_88)] px-6 py-4">
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
        <Outlet />
      </main>
      <DeployStatusFooter />
    </div>
  );
}
