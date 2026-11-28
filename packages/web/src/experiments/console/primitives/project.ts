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
   * project with no item on a pack stage, for a project read outside the list, and when the
   * server could not scan the item runs.
   */
  itemPacks: string[];
}

/** A codebase as the list serves it (with `item_packs`), or as a single read serves it. */
type RawCodebase =
  | components['schemas']['CodebaseListResponse'][number]
  | components['schemas']['Codebase'];

export function toProject(raw: RawCodebase): Project {
  return {
    id: raw.id,
    name: raw.name,
    path: raw.default_cwd,
    defaultBranch: raw.default_branch || null,
    repositoryUrl: raw.repository_url,
    lastSyncedAt: raw.updated_at,
    kind: raw.kind,
    itemPacks: ('item_packs' in raw ? raw.item_packs : null) ?? [],
  };
}
