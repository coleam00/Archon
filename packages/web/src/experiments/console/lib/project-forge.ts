import { useEntity, type EntityView } from '../store/cache';
import { K } from '../store/keys';
import * as skill from '../skills';
import type { ProjectForge } from '../skills/forge';

export type ForgeProject = Extract<ProjectForge, { kind: 'forge' }>;
export type ForgeOverview = Extract<ForgeProject['overview'], { status: 'ok' }>['value'];
export type ForgeItem = NonNullable<ForgeOverview['issues']>[number];

/**
 * A project's forge, shared by the tab, the header link, the rail counts and the forge
 * page through one cache key, so a project page costs one request.
 */
export function useProjectForge(projectId: string): EntityView<ProjectForge> {
  return useEntity<ProjectForge>(
    K.projectForge(projectId),
    () => skill.getProjectForge(projectId),
    { revalidateOnSubscribe: true }
  );
}

/** The overview when the project has a forge and its read succeeded. */
export function forgeOverview(forge: ProjectForge | undefined): ForgeOverview | undefined {
  return forge?.kind === 'forge' && forge.overview.status === 'ok'
    ? forge.overview.value
    : undefined;
}
