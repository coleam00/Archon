/**
 * Discover what packs declare about metrics in `<pack>/.shared/`: the metric views in
 * `metric-views.json` and the item metrics in `item-metrics.json`.
 *
 * Both are data: nothing here affects a workflow, script or run. They are read from every
 * place a pack lives, the same way for both files, with the scope precedence
 * `readPackDeclarations` owns.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { z } from 'zod';
import { readPackDeclarations } from './pack-declarations';
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
import { liveSourceRoots } from './workflow-source';
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

/**
 * The metric views one pack directory declares: null when it declares none, a problem when
 * its file does not read or validate.
 */
export async function loadPackMetricViews(
  packDir: string
): Promise<
  Pick<MetricViewsListing['packs'][number], 'names' | 'cards'> | { problem: string } | null
> {
  const listed = await readDeclaration(METRIC_VIEWS, '', 'project', packDir);
  if (listed === undefined) return null;
  if ('error' in listed) return { problem: listed.error };
  return { names: listed.declared.names ?? {}, cards: listed.declared.cards };
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
 * Every pack's declaration of `file` under `roots`. A declaration or scope root that cannot
 * be read, or a declaration that does not validate, is listed under `errors`; one broken
 * pack never hides the others.
 */
async function discoverPackDeclarations<T>(
  file: DeclarationFile<T>,
  roots: LiveWorkflowSourceRoots
): Promise<Declarations<T>> {
  const listing: Declarations<T> = { packs: [], errors: [] };
  for (const read of await readPackDeclarations(roots, file.path)) {
    const listed: Listed<T> =
      'error' in read
        ? { pack: read.pack, source: read.source, error: read.error }
        : parseDeclaration(file, read.pack, read.source, read.content);
    if ('error' in listed) listing.errors.push(listed);
    else listing.packs.push(listed);
  }
  return listing;
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
