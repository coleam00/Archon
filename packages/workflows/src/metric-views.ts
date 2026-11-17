/**
 * Discover what packs declare about metrics in `<pack>/.shared/`: the metric views in
 * `metric-views.json` and the item metrics in `item-metrics.json`.
 *
 * Both are data: nothing here affects a workflow, script or run. They are read from every
 * place a pack lives, the same way for both files. A pack folder's declaration at a higher
 * scope replaces a same-named folder's at a lower one (bundled < global < project), as
 * same-named workflow files do; installed packs are keyed by owner and name and never
 * collide.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BUNDLED_SCRIPT_PACKS, isBinaryBuild } from './defaults/bundled-defaults';
import { readBundleIndex } from './defaults/bundle-inventory';
import type { z } from 'zod';
import { PACK_SHARED_DIRECTORY } from './packaged-workflow';
import {
  ITEM_METRICS_FILE,
  itemMetricsFileSchema,
  type ItemMetricDefinition,
} from './schemas/item-metric';
import {
  METRIC_VIEWS_FILE,
  metricViewsFileSchema,
  type MetricViewsListing,
} from './schemas/metric-view';
import type { WorkflowSource } from './schemas';
import { listInstalledPacks, liveSourceRoots } from './workflow-source';
import type { LiveWorkflowSourceRoots } from './workflow-source/roots';

interface Located {
  pack: string;
  source: WorkflowSource;
}
type Unreadable = Located & { error: string };
type Listed<T> = (Located & { declared: T }) | Unreadable;
interface Declarations<T> {
  packs: (Located & { declared: T })[];
  errors: Unreadable[];
}

/** One declaration file: its name under `.shared/` and the schema it must match. */
interface DeclarationFile<T> {
  path: string;
  schema: z.ZodType<T>;
}

const SOURCE_ORDER: readonly WorkflowSource[] = ['bundled', 'global', 'project', 'installed'];

const METRIC_VIEWS = {
  path: `${PACK_SHARED_DIRECTORY}/${METRIC_VIEWS_FILE}`,
  schema: metricViewsFileSchema,
};
const ITEM_METRICS = {
  path: `${PACK_SHARED_DIRECTORY}/${ITEM_METRICS_FILE}`,
  schema: itemMetricsFileSchema,
};

/** Every pack's metric views under `roots`, as `discoverPackDeclarations` finds them. */
export async function discoverMetricViews(
  roots: LiveWorkflowSourceRoots = liveSourceRoots(null)
): Promise<MetricViewsListing> {
  const { packs, errors } = await discoverPackDeclarations(METRIC_VIEWS, roots);
  return {
    packs: packs.map(({ pack, source, declared }) => ({
      pack,
      source,
      names: declared.names ?? {},
      cards: declared.cards,
    })),
    errors,
  };
}

export interface ItemMetricsListing {
  packs: (Located & { metrics: ItemMetricDefinition[] })[];
  errors: Unreadable[];
}

/** Every pack's item metric definitions under `roots`, as `discoverPackDeclarations` finds them. */
export async function discoverItemMetrics(
  roots: LiveWorkflowSourceRoots = liveSourceRoots(null)
): Promise<ItemMetricsListing> {
  const { packs, errors } = await discoverPackDeclarations(ITEM_METRICS, roots);
  return {
    packs: packs.map(({ pack, source, declared }) => ({ pack, source, metrics: declared.metrics })),
    errors,
  };
}

/**
 * Every pack's declaration of `file` under `roots`. The bundled scope follows the roots'
 * config, as workflow discovery does. A declaration or scope root that cannot be read, or
 * a declaration that does not validate, is listed under `errors`; one broken pack never
 * hides the others.
 */
async function discoverPackDeclarations<T>(
  file: DeclarationFile<T>,
  roots: LiveWorkflowSourceRoots
): Promise<Declarations<T>> {
  const byFolder = new Map<string, Listed<T>>();
  const scopes: Listed<T>[][] = [
    roots.config.load_default_workflows ? await bundledDeclarations(file, roots) : [],
    await folderDeclarations(file, roots.globalWorkflows, 'global'),
    roots.project === null
      ? []
      : await folderDeclarations(file, join(roots.project, '.archon', 'workflows'), 'project'),
  ];
  for (const listed of scopes.flat()) byFolder.set(listed.pack, listed);

  const installed = await listInstalledPacks(roots.installed);
  const all: Listed<T>[] = [...byFolder.values()];
  for (const pack of installed.packs) {
    const listed = await readDeclaration(file, `${pack.owner}/${pack.name}`, 'installed', pack.dir);
    if (listed !== undefined) all.push(listed);
  }
  for (const failure of installed.errors)
    all.push({ pack: failure.path, source: 'installed', error: failure.message });

  all.sort(
    (a, b) =>
      SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source) ||
      a.pack.localeCompare(b.pack)
  );
  const listing: Declarations<T> = { packs: [], errors: [] };
  for (const listed of all) {
    if ('error' in listed) listing.errors.push(listed);
    else listing.packs.push(listed);
  }
  return listing;
}

async function bundledDeclarations<T>(
  file: DeclarationFile<T>,
  roots: LiveWorkflowSourceRoots
): Promise<Listed<T>[]> {
  const listed: Listed<T>[] = [];
  if (isBinaryBuild()) {
    for (const [pack, bundled] of Object.entries(BUNDLED_SCRIPT_PACKS)) {
      const content = bundled.files[file.path];
      if (content !== undefined) listed.push(parseDeclaration(file, pack, 'bundled', content));
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
    const declared = await readDeclaration(
      file,
      pack,
      'bundled',
      join(roots.bundledWorkflows, pack)
    );
    if (declared !== undefined) listed.push(declared);
  }
  return listed;
}

/** Each folder directly under a scope's workflow root is a pack that may declare. */
async function folderDeclarations<T>(
  file: DeclarationFile<T>,
  root: string,
  source: WorkflowSource
): Promise<Listed<T>[]> {
  let folders: string[];
  try {
    folders = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [{ pack: root, source, error: (error as Error).message }];
  }
  const listed: Listed<T>[] = [];
  for (const pack of folders.sort()) {
    const declared = await readDeclaration(file, pack, source, join(root, pack));
    if (declared !== undefined) listed.push(declared);
  }
  return listed;
}

/** A missing file, or a scope entry that is not a folder, declares nothing. */
async function readDeclaration<T>(
  file: DeclarationFile<T>,
  pack: string,
  source: WorkflowSource,
  packDir: string
): Promise<Listed<T> | undefined> {
  let content: string;
  try {
    content = await readFile(join(packDir, file.path), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    return { pack, source, error: (error as Error).message };
  }
  return parseDeclaration(file, pack, source, content);
}

function parseDeclaration<T>(
  file: DeclarationFile<T>,
  pack: string,
  source: WorkflowSource,
  content: string
): Listed<T> {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (error) {
    return { pack, source, error: `${file.path} is not JSON: ${(error as Error).message}` };
  }
  const parsed = file.schema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`);
    return { pack, source, error: `${file.path} is invalid: ${issues.join('; ')}` };
  }
  return { pack, source, declared: parsed.data };
}
