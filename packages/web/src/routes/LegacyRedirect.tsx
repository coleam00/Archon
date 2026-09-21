import { Navigate, matchPath, useLocation } from 'react-router';

export function legacyDestination(pathname: string, search: string): string {
  const path = pathname === '/legacy' ? '/' : pathname.replace(/^\/legacy\//, '/');
  if (path === '/settings') return '/console/settings';

  const run = matchPath('/workflows/runs/:runId', path);
  if (run?.params.runId) return `/console/r/${encodeURIComponent(run.params.runId)}`;

  if (path === '/workflows' || path === '/workflows/builder') {
    const oldQuery = new URLSearchParams(search);
    const name = oldQuery.get('edit');
    const project = oldQuery.get('project');
    const query = project ? `?${new URLSearchParams({ project }).toString()}` : '';
    return `/console/builder${name ? `/${encodeURIComponent(name)}` : ''}${query}`;
  }

  return '/console';
}

export function LegacyRedirect(): React.ReactElement {
  const { pathname, search } = useLocation();
  return <Navigate to={legacyDestination(pathname, search)} replace />;
}
