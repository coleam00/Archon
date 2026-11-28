/**
 * Live workflow discovery for a project root, kept while the files it reads stay as they were.
 * Discovery parses every workflow in reach and is most of what a pack graph read costs (over a
 * second for an install with a few packs), so a server that reads the graph on every page load
 * keeps it here (DESIGN.md, "Speed is a requirement": the graph is read once per pack copy).
 *
 * The key is a stamp of every directory and file under the roots live discovery reads
 * (`liveSourceRoots`: the project's `.archon/`, the home's workflows, commands and scripts, the
 * bundled workflows and the installed packs), plus the home's config and env files and the
 * project's configured command folder: path, modification time and size of each. Each call
 * stamps again (a few hundred `stat`s) and discovers again when anything was edited, added or
 * removed.
 *
 * Not kept, so discovered on every call: a project that is itself a pack folder
 * (`archon-plugin.json` at its root), whose whole tree discovery reads, and a root with a link
 * (a symlink or junction) anywhere under the stamped paths, since an edit behind a link does not
 * show in the stamp. A discovery that rejects is not kept either.
 */
import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as archonPaths from '@archon/paths';
import { PLUGIN_MANIFEST_FILE } from '@archon/plugin-manifest';
import type { WorkflowLoadResult } from '@archon/workflows/schemas/workflow';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { liveSourceRoots } from '@archon/workflows/workflow-source';

type LoadConfig = Parameters<typeof discoverWorkflowsWithConfig>[1];

/** What a link under a stamped path adds to the stamp: a stamp holding it is never kept. */
const LINK = 'link';

/** `path` and everything under it, one line per entry, into `out`. */
async function stampTree(path: string, out: string[]): Promise<void> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch {
    out.push(`- ${path}`);
    return;
  }
  out.push(
    `${info.isDirectory() ? 'd' : 'f'} ${path} ${String(info.mtimeMs)} ${String(info.size)}`
  );
  if (!info.isDirectory()) return;
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  const lines = await Promise.all(
    entries.map(async entry => {
      const child: string[] = [];
      const at = join(path, entry.name);
      if (entry.isSymbolicLink()) child.push(LINK);
      else if (entry.isDirectory()) await stampTree(at, child);
      else {
        const s = await stat(at).catch(() => null);
        child.push(s === null ? `- ${at}` : `f ${at} ${String(s.mtimeMs)} ${String(s.size)}`);
      }
      return child;
    })
  );
  for (const child of lines) out.push(...child);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  );
}

/** The stamp of what live discovery from `root` reads; null when a link makes it blind. */
async function discoveryStamp(root: string, loadConfig: LoadConfig): Promise<string | null> {
  const roots = liveSourceRoots(root);
  const folder = (await loadConfig(root)).commands?.folder;
  const out: string[] = [];
  for (const path of [
    join(root, '.archon'),
    ...(folder === undefined ? [] : [resolve(root, folder)]),
    roots.globalWorkflows,
    roots.globalCommands,
    roots.globalScripts,
    roots.bundledWorkflows,
    ...(roots.installed.kind === 'receipts' ? [roots.installed.pluginsDir] : []),
    archonPaths.getArchonConfigPath(),
    archonPaths.getArchonEnvPath(),
  ])
    await stampTree(path, out);
  return out.includes(LINK) ? null : out.join('\n');
}

/**
 * The most project roots whose discovery is kept, the root read least recently dropped first.
 * A server discovers for its registered projects, a handful on one install, so this is far
 * above a real install; it bounds what reads naming many roots can make the server hold.
 */
export const ROOTS_KEPT = 64;

/**
 * `discover(root)`, kept per root while its stamp is unchanged, for at most `ROOTS_KEPT`
 * roots. `discover` is live discovery with the same `loadConfig`
 * (`discoverWorkflowsWithConfig`); the stamp reads that config too.
 */
export function createDiscoveryCache(
  loadConfig: LoadConfig,
  discover: (root: string) => Promise<WorkflowLoadResult>
): (root: string) => Promise<WorkflowLoadResult> {
  const kept = new Map<string, { stamp: string; result: Promise<WorkflowLoadResult> }>();
  return async root => {
    if (await exists(join(root, PLUGIN_MANIFEST_FILE))) return discover(root);
    const stamp = await discoveryStamp(root, loadConfig);
    if (stamp === null) return discover(root);
    const entry = kept.get(root);
    // A Map iterates in insertion order: setting a root again makes it the newest.
    kept.delete(root);
    if (entry?.stamp === stamp) {
      kept.set(root, entry);
      return entry.result;
    }
    const result = discover(root);
    const fresh = { stamp, result };
    kept.set(root, fresh);
    for (const oldest of kept.keys()) {
      if (kept.size <= ROOTS_KEPT) break;
      kept.delete(oldest);
    }
    result.catch(() => {
      if (kept.get(root) === fresh) kept.delete(root);
    });
    return result;
  };
}
