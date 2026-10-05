import type { components } from '../../../lib/api.generated';
/** Project primitive. Canonical in-spike shape, normalized from server schema. */
export interface Project {
  id: string;
  name: string;
  path: string;
  defaultBranch: string | null;
  repositoryUrl: string | null;
  lastSyncedAt: string | null;
  /** 'folder' = non-git workspace running in place; 'repo' = git repository. */
  kind: 'repo' | 'folder';
}

type RawCodebase = components['schemas']['Codebase'];

export function toProject(raw: RawCodebase): Project {
  return {
    id: raw.id,
    name: raw.name,
    path: raw.default_cwd,
    defaultBranch: raw.default_branch || null,
    repositoryUrl: raw.repository_url,
    lastSyncedAt: raw.updated_at,
    kind: raw.kind,
  };
}
