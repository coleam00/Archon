import { Outlet } from 'react-router';
import { TopNav } from './TopNav';
import { DeployStatusFooter } from './DeployStatusFooter';

export function Layout(): React.ReactElement {
  return (
    <div className="flex h-screen flex-col bg-background">
      <TopNav />
      {/* Seamless blend strip between navy nav and ivory canvas */}
      <div className="pmc-nav-blend" aria-hidden="true" />
      <main className="flex flex-1 flex-col overflow-hidden">
        <Outlet />
      </main>
      <DeployStatusFooter />
    </div>
  );
}
