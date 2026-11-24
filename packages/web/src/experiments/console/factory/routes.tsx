import type { ReactElement } from 'react';
import { Route } from 'react-router';
import { BoardPage } from './BoardPage';
import { FactoryNotFound } from './FactoryNotFound';
import { FactoryPage } from './FactoryPage';
import { ItemPage } from './ItemPage';
import { StepPage } from './StepPage';
import { ProjectSettingsPage } from './settings/ProjectSettingsPage';

/**
 * The Factory section's routes, a child of the project's route (`projectRoutes`), whose
 * layout shares the attention stream. A function returning a `<Route>` rather than a
 * component, because `<Routes>` reads its children's route elements directly.
 */
export function factoryRoutes(): ReactElement {
  return (
    <Route path="factory">
      <Route index element={<FactoryPage />} />
      <Route path="board" element={<BoardPage />} />
      <Route path="settings" element={<ProjectSettingsPage />} />
      <Route path="items/:key" element={<ItemPage />} />
      <Route path="steps/:workflow/:node" element={<StepPage />} />
      <Route path="*" element={<FactoryNotFound />} />
    </Route>
  );
}
