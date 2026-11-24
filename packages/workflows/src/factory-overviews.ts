/**
 * Discover factory overviews (`schemas/factory-overview.ts`) for a project, found as factory
 * views are (`factory-pack-files.ts`): a project file `.archon/packs/<pack key>.factory-overview.json`,
 * then `<pack>/.shared/factory-overview.json` in every pack the project can run; and which
 * overview each pack's page shows across the install (`resolveFactoryPacks`).
 */
import { discoverPackFiles, factoryPackKey } from './factory-pack-files';
import {
  FACTORY_OVERVIEW_FILE,
  FACTORY_OVERVIEW_PROJECT_SUFFIX,
  factoryOverviewSchema,
  type FactoryOverviewsListing,
  type FactoryPacks,
} from './schemas/factory-overview';
import type { LiveWorkflowSourceRoots } from './workflow-source/roots';

/** Every overview and error under `roots`. */
export async function discoverFactoryOverviews(
  roots: LiveWorkflowSourceRoots
): Promise<FactoryOverviewsListing> {
  const { found, errors } = await discoverPackFiles(
    {
      fileName: FACTORY_OVERVIEW_FILE,
      projectSuffix: FACTORY_OVERVIEW_PROJECT_SUFFIX,
      schema: factoryOverviewSchema,
    },
    roots
  );
  return { overviews: found, errors };
}

type ListedOverview = FactoryOverviewsListing['overviews'][number];
type OverviewError = FactoryOverviewsListing['errors'][number];
type FactoryPack = FactoryPacks['packs'][number];
interface ProjectRef {
  codebaseId: string;
  name: string;
}

/** One project's overview files and the packs of its applying factory views, or why it could not be read. */
export type FactoryPackProject =
  | (ProjectRef & { listing: FactoryOverviewsListing; viewPacks: readonly string[] })
  | (ProjectRef & { error: string });

/** A file of the project's own: its `.archon/packs/` file, or a pack folder in its checkout. */
const ownedByProject = (listed: { source: string }): boolean =>
  listed.source === 'project-file' || listed.source === 'project';

/**
 * Every pack with an overview file, for the console's Factory pages. The pack's own file
 * (bundled, global or installed: `home`, read with no project) wins; else the first project,
 * by name then id, whose own files give one, named in `readFrom`. A broken pack file falls
 * back to a project's file and stays listed, so the page is useful and the break visible. A
 * pack with only broken files is listed with no overview. Factory views keep their own
 * precedence (`discoverPackFiles`): only the overview a pack page shows is resolved here.
 */
export function resolveFactoryPacks(input: {
  home: FactoryOverviewsListing;
  projects: readonly FactoryPackProject[];
}): FactoryPacks {
  const projects = [...input.projects].sort(
    (a, b) => a.name.localeCompare(b.name) || a.codebaseId.localeCompare(b.codebaseId)
  );
  const read = projects.filter(
    (project): project is Extract<FactoryPackProject, { listing: unknown }> => 'listing' in project
  );
  const packs = new Map<string, FactoryPack>();
  const entry = (pack: string): FactoryPack => {
    const key = factoryPackKey(pack);
    let found = packs.get(key);
    if (found === undefined) {
      found = { pack, key, overview: null, readFrom: null, projects: [], errors: [] };
      packs.set(key, found);
    }
    return found;
  };

  for (const listed of input.home.overviews) adopt(entry(listed.pack), listed, null);
  for (const project of read)
    for (const listed of project.listing.overviews.filter(ownedByProject))
      adopt(entry(listed.pack), listed, { codebaseId: project.codebaseId, name: project.name });

  const errors: OverviewError[] = [];
  const seen = new Set<string>();
  for (const error of [input.home.errors, ...read.map(p => p.listing.errors)].flat()) {
    if (seen.has(error.path)) continue;
    seen.add(error.path);
    // A scope root that could not be read is listed under its own path: it names no pack.
    if (error.path === error.pack) errors.push(error);
    else entry(error.pack).errors.push(error);
  }

  for (const project of read)
    for (const key of new Set(project.viewPacks.map(factoryPackKey)))
      packs.get(key)?.projects.push({ codebaseId: project.codebaseId, name: project.name });

  return {
    packs: [...packs.values()].sort((a, b) => packLabel(a).localeCompare(packLabel(b))),
    errors,
    unreadProjects: projects.flatMap(project =>
      'error' in project
        ? [{ codebaseId: project.codebaseId, name: project.name, error: project.error }]
        : []
    ),
  };
}

/** Take `listed` as the pack's overview unless an earlier one already gave it. */
function adopt(pack: FactoryPack, listed: ListedOverview, readFrom: ProjectRef | null): void {
  if (pack.overview !== null) return;
  pack.overview = listed;
  pack.pack = listed.pack;
  pack.readFrom = readFrom;
}

const packLabel = (pack: FactoryPack): string => pack.overview?.declaration.title ?? pack.key;
