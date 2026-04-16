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

export async function addProjectByUrl(url: string): Promise<Project> {
  const raw = await requestJson<Parameters<typeof toProject>[0]>('/api/codebases', {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
  return toProject(raw);
}

export async function addProjectByPath(path: string): Promise<Project> {
  const raw = await requestJson<Parameters<typeof toProject>[0]>('/api/codebases', {
    method: 'POST',
    body: JSON.stringify({ path }),
  });
  return toProject(raw);
}

export async function removeProject(id: string): Promise<void> {
  await requestJson(`/api/codebases/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}
