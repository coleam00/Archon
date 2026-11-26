/**
 * The factory view a pack ships (`<pack>/.shared/factory-view.json`, `schemas/factory-view.ts`)
 * for the project at `cwd`, read entry by entry and reconciled with the pack's graph
 * (`servedFactoryView`): an entry that does not read or names what the graph lacks is left out
 * and listed, the rest served. It is read through `readPackDeclarations` from the same copy of
 * the pack the graph was read from. `GET /api/packs/{pack}/view` serves it.
 */
import { FACTORY_VIEW_PATH } from '@archon/workflows/factory-view-check';
import { servedFactoryView } from '@archon/workflows/factory-view-read';
import { readPackDeclarations } from '@archon/workflows/pack-declarations';
import type { FactoryView, FactoryViewProblem } from '@archon/workflows/schemas/factory-view';
import { installedPackKey, liveSourceRoots } from '@archon/workflows/workflow-source';
import type { PackGraph } from '@archon/workflows/pack-graph';
import { readPackGraph } from './pack-graph';

export interface PackViewRead {
  /** The file read, or null when the pack ships none. */
  path: string | null;
  /** The view as served (what reads and names what the graph has), or null when there is no file or it does not read. */
  view: FactoryView | null;
  problems: FactoryViewProblem[];
}

/** A declaration's pack as a pack key: `owner/name` of an installed pack is `owner.name`. */
function declarationKey(pack: string): string {
  const slash = pack.indexOf('/');
  return slash === -1 ? pack : installedPackKey(pack.slice(0, slash), pack.slice(slash + 1));
}

const unreadable = (message: string): FactoryViewProblem => ({
  kind: 'unreadable',
  path: [],
  message,
});

export async function readPackView(
  cwd: string,
  packKey: string,
  deps: Parameters<typeof readPackGraph>[2],
  options: { workflowSource?: string } = {}
): Promise<PackViewRead> {
  return packViewOf(await readPackGraph(cwd, packKey, deps, options), cwd, options);
}

/**
 * The view file of the pack `graph` was read for, from the same copy, checked against that
 * graph. A caller that has the graph already (the server, which shares one graph read between
 * the graph and view routes) checks the view without reading the graph again.
 */
export async function packViewOf(
  graph: PackGraph,
  cwd: string,
  options: { workflowSource?: string } = {}
): Promise<PackViewRead> {
  const loaded = graph.loaded[0];
  const reads = await readPackDeclarations(
    liveSourceRoots(options.workflowSource ?? cwd),
    FACTORY_VIEW_PATH
  );
  const read = reads.find(
    entry =>
      loaded !== undefined &&
      entry.source === loaded.source &&
      declarationKey(entry.pack) === loaded.key
  );
  if (read === undefined) return { path: null, view: null, problems: [] };
  if ('error' in read)
    return { path: read.path, view: null, problems: [unreadable(`cannot be read: ${read.error}`)] };
  let json: unknown;
  try {
    json = JSON.parse(read.content);
  } catch (error) {
    return {
      path: read.path,
      view: null,
      problems: [unreadable(`is not JSON: ${(error as Error).message}`)],
    };
  }
  return { path: read.path, ...servedFactoryView(json, graph) };
}
