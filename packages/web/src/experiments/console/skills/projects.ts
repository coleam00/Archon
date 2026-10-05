import type { components } from '../../../lib/api.generated';
import { requestJson } from '../lib/http';
import { toProject, type Project } from '../primitives/project';

export async function listProjects(): Promise<Project[]> {
  const raw = await requestJson<Parameters<typeof toProject>[0][]>('/api/codebases');
  return raw.map(toProject);
}

export async function getProject(id: string): Promise<Project> {
  const raw = await requestJson<Parameters<typeof toProject>[0]>(
    `/api/codebases/${encodeURIComponent(id)}`
  );
  return toProject(raw);
}

export async function addProjectByUrl(
  url: string,
  baseBranch: string | null = null
): Promise<Project> {
  const raw = await requestJson<Parameters<typeof toProject>[0]>('/api/codebases', {
    method: 'POST',
    body: JSON.stringify({
      url,
      base_branch: baseBranch,
    } satisfies components['schemas']['AddCodebaseBody']),
  });
  return toProject(raw);
}

export async function addProjectByPath(
  path: string,
  baseBranch: string | null = null
): Promise<Project> {
  const raw = await requestJson<Parameters<typeof toProject>[0]>('/api/codebases', {
    method: 'POST',
    body: JSON.stringify({
      path,
      base_branch: baseBranch,
    } satisfies components['schemas']['AddCodebaseBody']),
  });
  return toProject(raw);
}

export async function removeProject(id: string): Promise<void> {
  await requestJson(`/api/codebases/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export type BaseBranchInspection = components['schemas']['InspectBaseBranchResponse'];
export async function inspectProjectBaseBranch(
  source: components['schemas']['InspectBaseBranchBody']
): Promise<BaseBranchInspection> {
  return requestJson<BaseBranchInspection>('/api/codebases/base-branch', {
    method: 'POST',
    body: JSON.stringify(source),
  });
}
