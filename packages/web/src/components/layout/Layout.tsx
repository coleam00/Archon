import { Outlet } from 'react-router';
import { SidebarNav } from './SidebarNav';

export function Layout(): React.ReactElement {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background">
      <SidebarNav />
      <main className="flex flex-1 flex-col overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
