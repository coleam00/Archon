import type { components } from '../../../lib/api.generated';
/** Project primitive. Canonical in-spike shape, normalized from server schema. */
export interface Project {
  id: string;
  name: string;
  path: string;
  defaultBranch: string | null;
  repositoryUrl: string | null;
  lastSyncedAt: string | null;
  /** 'folder' = runs in place without Archon-managed git (directory may have git); 'repo' = git repository. */
  kind: 'repo' | 'folder';
  /**
   * The workflow packs with a run on an item of the project, by pack key. Empty for a
   * project with no item on a pack stage, and for a project read outside the list.
   */
  itemPacks: string[];
}

type RawCodebase = components['schemas']['Codebase'] & { item_packs?: string[] };

export function toProject(raw: RawCodebase): Project {
  return {
    id: raw.id,
    name: raw.name,
    path: raw.default_cwd,
    defaultBranch: raw.default_branch || null,
    repositoryUrl: raw.repository_url,
    lastSyncedAt: raw.updated_at,
    kind: raw.kind,
    itemPacks: raw.item_packs ?? [],
  };
}
