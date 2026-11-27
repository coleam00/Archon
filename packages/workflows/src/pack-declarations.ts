/**
 * Read one display declaration file, such as `.shared/metric-views.json`, from every place a
 * pack lives, agreeing with workflow discovery on which packs exist and which copy wins.
 *
 * A pack folder's file at a higher scope replaces a same-named folder's at a lower one
 * (bundled < global < project), as same-named workflow files do, even when the higher one
 * cannot be read. Installed packs are keyed by owner and name and never collide. This only
 * reads: each caller parses the content against its own schema.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BUNDLED_SCRIPT_PACKS, isBinaryBuild } from './defaults/bundled-defaults';
import { readBundleIndex } from './defaults/bundle-inventory';
import type { WorkflowSource } from './schemas';
import { listInstalledPacks } from './workflow-source';
import type { LiveWorkflowSourceRoots } from './workflow-source/roots';

/**
 * One pack's declaration file, or why it could not be read. `pack` is the folder name, or
 * `owner/name` for an installed pack; a scope that could not be listed names its root
 * instead. `path` is the file's absolute path, or `bundled:<pack>/<file>` inside a binary.
 */
type PackDeclarationRead =
  | { pack: string; source: WorkflowSource; path: string; content: string }
  | { pack: string; source: WorkflowSource; path: string; error: string };

const SOURCE_ORDER: readonly WorkflowSource[] = ['bundled', 'global', 'project', 'installed'];

/**
 * Every pack's `relativePath` file under `roots`, sorted by scope then pack. The bundled
 * scope follows the roots' config, as workflow discovery does. A pack without the file is
 * absent; a file or scope root that cannot be read is an error, and never hides the others.
 *
 * `relativePath` uses `/` separators: it is also the key of a bundled binary's file map.
 */
export async function readPackDeclarations(
  roots: LiveWorkflowSourceRoots,
  relativePath: string
): Promise<PackDeclarationRead[]> {
  const byFolder = new Map<string, PackDeclarationRead>();
  const scopes: PackDeclarationRead[][] = [
    roots.config.load_default_workflows ? await bundledDeclarations(roots, relativePath) : [],
    await folderDeclarations(roots.globalWorkflows, 'global', relativePath),
    roots.project === null
      ? []
      : await folderDeclarations(
          join(roots.project, '.archon', 'workflows'),
          'project',
          relativePath
        ),
  ];
  for (const read of scopes.flat()) byFolder.set(read.pack, read);

  const installed = await listInstalledPacks(roots.installed);
  const all: PackDeclarationRead[] = [...byFolder.values()];
  for (const pack of installed.packs) {
    const read = await readDeclaration(
      `${pack.owner}/${pack.name}`,
      'installed',
      pack.dir,
      relativePath
    );
    if (read !== undefined) all.push(read);
  }
  for (const failure of installed.errors)
    all.push({
      pack: failure.path,
      source: 'installed',
      path: failure.path,
      error: failure.message,
    });

  return all.sort(
    (a, b) =>
      SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source) ||
      a.pack.localeCompare(b.pack)
  );
}

async function bundledDeclarations(
  roots: LiveWorkflowSourceRoots,
  relativePath: string
): Promise<PackDeclarationRead[]> {
  const listed: PackDeclarationRead[] = [];
  if (isBinaryBuild()) {
    for (const [pack, bundled] of Object.entries(BUNDLED_SCRIPT_PACKS)) {
      const content = bundled.files[relativePath];
      if (content !== undefined)
        listed.push({ pack, source: 'bundled', path: `bundled:${pack}/${relativePath}`, content });
    }
    return listed;
  }
  let packs: string[];
  try {
    packs = await readBundleIndex();
  } catch (error) {
    const root = roots.bundledWorkflows;
    return [{ pack: root, source: 'bundled', path: root, error: (error as Error).message }];
  }
  for (const pack of packs) {
    const read = await readDeclaration(
      pack,
      'bundled',
      join(roots.bundledWorkflows, pack),
      relativePath
    );
    if (read !== undefined) listed.push(read);
  }
  return listed;
}

/** Each folder directly under a scope's workflow root is a pack that may declare. */
async function folderDeclarations(
  root: string,
  source: WorkflowSource,
  relativePath: string
): Promise<PackDeclarationRead[]> {
  let folders: string[];
  try {
    folders = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [{ pack: root, source, path: root, error: (error as Error).message }];
  }
  const listed: PackDeclarationRead[] = [];
  for (const pack of folders.sort()) {
    const read = await readDeclaration(pack, source, join(root, pack), relativePath);
    if (read !== undefined) listed.push(read);
  }
  return listed;
}

/** A missing file, or a scope entry that is not a folder, declares nothing. */
async function readDeclaration(
  pack: string,
  source: WorkflowSource,
  packDir: string,
  relativePath: string
): Promise<PackDeclarationRead | undefined> {
  const path = join(packDir, ...relativePath.split('/'));
  try {
    return { pack, source, path, content: await readFile(path, 'utf8') };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    return { pack, source, path, error: (error as Error).message };
  }
}
