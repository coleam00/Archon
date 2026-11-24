import type { ReactElement } from 'react';
import { Route } from 'react-router';
import { ProjectAttentionLayout } from '../components/ProjectAttention';
import { factoryRoutes } from '../factory/routes';
import { ChatPage } from './ChatPage';
import { MetricsPage } from './metrics/MetricsPage';
import { NeedsYouPage } from './NeedsYouPage';
import { RunDetailPage } from './RunDetailPage';
import { RunsPage } from './RunsPage';

/**
 * Every page of one project, under the layout that holds its attention queue and stream, so
 * the Needs you tab's count is live on each of them. A function returning a `<Route>` rather
 * than a component, because `<Routes>` reads its children's route elements directly. `base` is
 * what precedes `p/:projectId`: the console nests it under `/console/*`, a test mounts it at
 * the root.
 */
export function projectRoutes(base: '' | '/console/'): ReactElement {
  return (
    <Route path={`${base}p/:projectId`} element={<ProjectAttentionLayout />}>
      <Route index element={<RunsPage />} />
      <Route path="needs-you" element={<NeedsYouPage />} />
      <Route path="chat" element={<ChatPage />} />
      <Route path="metrics" element={<MetricsPage />} />
      <Route path="metrics/details" element={<MetricsPage view="details" />} />
      {factoryRoutes()}
      <Route path="r/:runId" element={<RunDetailPage />} />
    </Route>
  );
}
