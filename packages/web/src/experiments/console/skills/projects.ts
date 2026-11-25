import type { components } from '../../../lib/api.generated';
import { requestJson } from '../lib/http';
import { toProject, type Project } from '../primitives/project';

export async function listProjects(): Promise<Project[]> {
  const raw = await requestJson('/api/codebases', 'get');
  return raw.map(toProject);
}

export async function getProject(id: string): Promise<Project> {
  const raw = await requestJson('/api/codebases/{id}', 'get', { params: { id } });
  return toProject(raw);
}

export async function addProjectByUrl(
  url: string,
  baseBranch: string | null = null
): Promise<Project> {
  const raw = await requestJson('/api/codebases', 'post', {
    body: {
      url,
      base_branch: baseBranch,
    } satisfies components['schemas']['AddCodebaseBody'],
  });
  return toProject(raw);
}

export async function addProjectByPath(
  path: string,
  baseBranch: string | null = null,
  folder = false
): Promise<Project> {
  const raw = await requestJson('/api/codebases', 'post', {
    body: {
      path,
      ...(folder ? { folder: true } : {}),
      base_branch: baseBranch,
    } satisfies components['schemas']['AddCodebaseBody'],
  });
  return toProject(raw);
}

export async function renameProject(id: string, name: string): Promise<Project> {
  const raw = await requestJson('/api/codebases/{id}', 'patch', {
    params: { id },
    body: { name } satisfies components['schemas']['RenameCodebaseBody'],
  });
  return toProject(raw);
}

export async function removeProject(id: string): Promise<void> {
  await requestJson('/api/codebases/{id}', 'delete', { params: { id } });
}

export type BaseBranchInspection = components['schemas']['InspectBaseBranchResponse'];
export async function inspectProjectBaseBranch(
  source: components['schemas']['InspectBaseBranchBody']
): Promise<BaseBranchInspection> {
  return requestJson('/api/codebases/base-branch', 'post', { body: source });
}
