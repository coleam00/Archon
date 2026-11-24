import type { ReactElement } from 'react';
import { Navigate, Route, useLocation, useParams } from 'react-router';
import { factoryPackPath, factoryPath } from '../lib/views';
import { PackIndexPage } from './PackIndexPage';
import { PackPage } from './PackPage';

/**
 * The sidebar's Factory pages: every pack, then one pack's How it works. A function returning a
 * `<Route>`, as `factoryRoutes` is, so `<Routes>` reads its children directly. `base` is
 * what precedes `factory`: the console nests it under `/console/*`, a test mounts it at
 * `/console/`.
 */
export function factoryPackRoutes(base: '' | '/console/'): ReactElement {
  return (
    <Route path={`${base}factory`}>
      <Route index element={<PackIndexPage />} />
      <Route path=":pack" element={<Navigate replace to="how-it-works" />} />
      <Route path=":pack/how-it-works" element={<PackPage />} />
      <Route path=":pack/settings" element={<PackSettingsMoved />} />
    </Route>
  );
}

/**
 * Settings were the pack page's second tab, `?project=` naming the project shown; they are a
 * project's Factory page now (owner change of 2026-11-23). An old link with a project lands on
 * that project's Settings; one without lands on the pack's How it works, which names none.
 */
function PackSettingsMoved(): ReactElement {
  const { pack = '' } = useParams<{ pack: string }>();
  const { search, hash } = useLocation();
  const params = new URLSearchParams(search);
  const project = params.get('project');
  params.delete('project');
  const rest = params.toString();
  const pathname =
    project === null || project === ''
      ? factoryPackPath(pack)
      : factoryPath(encodeURIComponent(project), '/settings');
  return <Navigate replace to={{ pathname, search: rest === '' ? '' : `?${rest}`, hash }} />;
}
