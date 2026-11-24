/**
 * Discover factory views (`schemas/factory-view.ts`) for a project, and decide which apply.
 *
 * A project file `.archon/packs/<pack key>.factory-view.json` comes first, so a project may
 * present an installed pack it cannot edit; then `<pack>/.shared/factory-view.json` in every
 * pack the project can run (`factory-pack-files.ts`). A file that cannot be read or does not
 * validate is listed under `errors` with its path; it never hides the others.
 */
import { discoverPackFiles, factoryPackKey, installedIdentity } from './factory-pack-files';
import {
  FACTORY_VIEW_FILE,
  FACTORY_VIEW_PROJECT_SUFFIX,
  factoryViewSchema,
  type FactoryViewsListing,
} from './schemas/factory-view';
import { installedWorkflowName } from './workflow-source/installed-packs';
import type { LiveWorkflowSourceRoots } from './workflow-source/roots';

export { factoryPackKey } from './factory-pack-files';

/** Whether a view's `pack` names an installed pack (`owner/name`) rather than a folder pack. */
export function factoryPackIsInstalled(pack: string): boolean {
  return installedIdentity(pack) !== undefined;
}

/**
 * The name a run of `workflow` from `pack` records: `owner/name:workflow` for an installed
 * pack, the bare workflow name for a folder pack.
 */
export function factoryRunWorkflowName(pack: string, workflow: string): string {
  const installed = installedIdentity(pack);
  if (installed === undefined) return workflow;
  return installedWorkflowName(installed, workflow);
}

/** Every view and error under `roots` (`factory-pack-files.ts` says where it looks, in what order). */
export async function discoverFactoryViews(
  roots: LiveWorkflowSourceRoots
): Promise<FactoryViewsListing> {
  const { found, errors } = await discoverPackFiles(
    {
      fileName: FACTORY_VIEW_FILE,
      projectSuffix: FACTORY_VIEW_PROJECT_SUFFIX,
      schema: factoryViewSchema,
    },
    roots
  );
  // Each view carries its pack key and run names, so the web never re-derives either.
  const views = found.map(view => ({
    ...view,
    packKey: factoryPackKey(view.pack),
    runNames: Object.fromEntries(
      view.declaration.stages.flatMap(stage =>
        stage.workflows.map(workflow => [workflow, factoryRunWorkflowName(view.pack, workflow)])
      )
    ),
  }));
  return { views, errors };
}

/** The run names, as runs record them, of every workflow a listed view's stages name. */
export function factoryViewWorkflowNames(listing: FactoryViewsListing): string[] {
  const names = new Set<string>();
  for (const view of listing.views)
    for (const stage of view.declaration.stages)
      for (const workflow of stage.workflows)
        names.add(factoryRunWorkflowName(view.pack, workflow));
  return [...names];
}

/**
 * The views that apply to a project: its own project files, and a pack's view once the
 * project has run a workflow the view names. `ranWorkflowNames` holds run names as runs
 * record them. Errors stay listed, so a broken file is never silent.
 */
export function factoryViewsForProject(
  listing: FactoryViewsListing,
  ranWorkflowNames: ReadonlySet<string>
): FactoryViewsListing {
  return {
    views: listing.views.filter(
      view =>
        view.source === 'project-file' ||
        view.declaration.stages.some(stage =>
          stage.workflows.some(workflow =>
            ranWorkflowNames.has(factoryRunWorkflowName(view.pack, workflow))
          )
        )
    ),
    errors: listing.errors,
  };
}
