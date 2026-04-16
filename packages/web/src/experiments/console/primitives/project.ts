/** Project primitive. Canonical in-spike shape, normalized from server schema. */
export interface Project {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  repositoryUrl: string | null;
  lastSyncedAt: string | null;
}

interface RawCodebase {
  id: string;
  name: string;
  default_cwd: string;
  default_branch?: string | null;
  repository_url: string | null;
  updated_at: string;
  created_at: string;
}

export function toProject(raw: RawCodebase): Project {
  return {
    id: raw.id,
    name: raw.name,
    path: raw.default_cwd,
    defaultBranch: raw.default_branch ?? 'main',
    repositoryUrl: raw.repository_url,
    lastSyncedAt: raw.updated_at,
  };
}
