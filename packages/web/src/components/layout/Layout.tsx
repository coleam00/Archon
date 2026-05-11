import { Outlet } from 'react-router';
import { TopNav } from './TopNav';

export function Layout(): React.ReactElement {
  return (
    <div className="flex h-screen flex-col bg-background">
      <TopNav />
      <main className="flex flex-1 flex-col overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
