import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import { Outlet, useParams } from 'react-router';
import { useProjectAttentionRead } from '../lib/attention-stream';
import type { AttentionQueue } from '../skills/runs';
import type { EntityView } from '../store/cache';

const ProjectAttentionContext = createContext<EntityView<AttentionQueue> | null>(null);

/**
 * The parent route of every page of one project (`p/:projectId`). It holds the project's
 * attention queue and its one stream, so the Needs you tab's count stays live on Runs, Chat,
 * Metrics and every Factory page, and moving between them keeps that stream open instead of
 * closing and reopening it on each page; leaving the project closes it.
 */
export function ProjectAttentionLayout(): ReactElement {
  const { projectId = '' } = useParams<{ projectId: string }>();
  return (
    <ProjectAttentionProvider projectId={projectId}>
      <Outlet />
    </ProjectAttentionProvider>
  );
}

/**
 * The provider the layout mounts, for a test or a surface that draws a project's tabs or ask
 * cards outside the routed pages. It opens the project's one stream; never nest two.
 */
export function ProjectAttentionProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}): ReactElement {
  const attention = useProjectAttentionRead(projectId);
  return (
    <ProjectAttentionContext.Provider value={attention}>
      {children}
    </ProjectAttentionContext.Provider>
  );
}

/**
 * The project's attention queue. Outside `ProjectAttentionLayout` it throws rather than open a
 * stream of its own: a page that quietly opened one would bring back a stream per page.
 */
export function useProjectAttention(): EntityView<AttentionQueue> {
  const attention = useContext(ProjectAttentionContext);
  if (attention === null)
    throw new Error('useProjectAttention needs a page routed under ProjectAttentionLayout');
  return attention;
}
