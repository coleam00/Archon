/**
 * Discover the metric views packs declare in `<pack>/.shared/metric-views.json`.
 *
 * Views are display only: nothing here affects a workflow, script or run. They are read
 * from every place a pack lives. A pack folder's declaration at a higher scope replaces a
 * same-named folder's at a lower one (bundled < global < project), as same-named
 * workflow files do; installed packs are keyed by owner and name and never collide.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BUNDLED_SCRIPT_PACKS, isBinaryBuild } from './defaults/bundled-defaults';
import { readBundleIndex } from './defaults/bundle-inventory';
import { PACK_SHARED_DIRECTORY } from './packaged-workflow';
import {
  METRIC_VIEWS_FILE,
  metricViewsFileSchema,
  type MetricViewsListing,
} from './schemas/metric-view';
import type { WorkflowSource } from './schemas';
import { listInstalledPacks, liveSourceRoots } from './workflow-source';
import type { LiveWorkflowSourceRoots } from './workflow-source/roots';

type Listed = MetricViewsListing['packs'][number] | MetricViewsListing['errors'][number];

const DECLARATION_PATH = `${PACK_SHARED_DIRECTORY}/${METRIC_VIEWS_FILE}`;
const SOURCE_ORDER: readonly WorkflowSource[] = ['bundled', 'global', 'project', 'installed'];

/**
 * Every pack's declaration under `roots`. The bundled scope follows the roots' config, as
 * workflow discovery does. A declaration or scope root that cannot be read, or a
 * declaration that does not validate, is listed under `errors`; one broken pack never
 * hides the others.
 */
export async function discoverMetricViews(
  roots: LiveWorkflowSourceRoots = liveSourceRoots(null)
): Promise<MetricViewsListing> {
  const byFolder = new Map<string, Listed>();
  const scopes: Listed[][] = [
    roots.config.load_default_workflows ? await bundledDeclarations(roots) : [],
    await folderDeclarations(roots.globalWorkflows, 'global'),
    roots.project === null
      ? []
      : await folderDeclarations(join(roots.project, '.archon', 'workflows'), 'project'),
  ];
  for (const listed of scopes.flat()) byFolder.set(listed.pack, listed);

  const installed = await listInstalledPacks(roots.installed);
  const all: Listed[] = [...byFolder.values()];
  for (const pack of installed.packs) {
    const listed = await readDeclaration(`${pack.owner}/${pack.name}`, 'installed', pack.dir);
    if (listed !== undefined) all.push(listed);
  }
  for (const failure of installed.errors)
    all.push({ pack: failure.path, source: 'installed', error: failure.message });

  all.sort(
    (a, b) =>
      SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source) ||
      a.pack.localeCompare(b.pack)
  );
  const listing: MetricViewsListing = { packs: [], errors: [] };
  for (const listed of all) {
    if ('error' in listed) listing.errors.push(listed);
    else listing.packs.push(listed);
  }
  return listing;
}

async function bundledDeclarations(roots: LiveWorkflowSourceRoots): Promise<Listed[]> {
  const listed: Listed[] = [];
  if (isBinaryBuild()) {
    for (const [pack, bundled] of Object.entries(BUNDLED_SCRIPT_PACKS)) {
      const content = bundled.files[DECLARATION_PATH];
      if (content !== undefined) listed.push(parseDeclaration(pack, 'bundled', content));
    }
    return listed;
  }
  let packs: string[];
  try {
    packs = await readBundleIndex();
  } catch (error) {
    return [{ pack: roots.bundledWorkflows, source: 'bundled', error: (error as Error).message }];
  }
  for (const pack of packs) {
    const declared = await readDeclaration(pack, 'bundled', join(roots.bundledWorkflows, pack));
    if (declared !== undefined) listed.push(declared);
  }
  return listed;
}

/** Each folder directly under a scope's workflow root is a pack that may declare views. */
async function folderDeclarations(root: string, source: WorkflowSource): Promise<Listed[]> {
  let folders: string[];
  try {
    folders = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [{ pack: root, source, error: (error as Error).message }];
  }
  const listed: Listed[] = [];
  for (const pack of folders.sort()) {
    const declared = await readDeclaration(pack, source, join(root, pack));
    if (declared !== undefined) listed.push(declared);
  }
  return listed;
}

/** A missing file, or a scope entry that is not a folder, declares nothing. */
async function readDeclaration(
  pack: string,
  source: WorkflowSource,
  packDir: string
): Promise<Listed | undefined> {
  let content: string;
  try {
    content = await readFile(join(packDir, DECLARATION_PATH), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    return { pack, source, error: (error as Error).message };
  }
  return parseDeclaration(pack, source, content);
}

function parseDeclaration(pack: string, source: WorkflowSource, content: string): Listed {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (error) {
    return { pack, source, error: `${DECLARATION_PATH} is not JSON: ${(error as Error).message}` };
  }
  const parsed = metricViewsFileSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`);
    return { pack, source, error: `${DECLARATION_PATH} is invalid: ${issues.join('; ')}` };
  }
  return { pack, source, names: parsed.data.names ?? {}, cards: parsed.data.cards };
}
