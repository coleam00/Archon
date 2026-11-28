import { requestJson } from '../lib/http';
import type { components } from '@/lib/api.generated';

export type ProjectForge = components['schemas']['ProjectForge'];

/** A project's repository on its forge: no forge, an unresolved one, or its overview. */
export async function getProjectForge(projectId: string): Promise<ProjectForge> {
  return requestJson('/api/codebases/{id}/forge', 'get', { params: { id: projectId } });
}
