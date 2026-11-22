import { readFile, stat } from 'fs/promises';
import { basename, dirname, join } from 'path';
import * as archonPaths from '@archon/paths';
import {
  describeIssues,
  PLUGIN_MANIFEST_FILE,
  workflowPackManifestSchema,
} from '@archon/plugin-manifest';
import { hasGitMarker, runGit } from '../checkout-observation';
import { isDirectory, listTree, type TreeFile, type TreeListing } from './tree';

/**
 * A pack's own folder given as the workflow source: the folder whose root holds a
 * workflow-pack `archon-plugin.json`. It is read as one project-scope pack keyed by its
 * manifest `name`, as if it sat at `<source>/.archon/workflows/<name>/`, so a pack author
 * can run the pack without installing it or copying it into that layout. A run's capture
 * freezes the folder whole as its project root, so the frozen copy is read by this rule too.
 */
export interface SourcePackFolder {
  /** The manifest `name`: the pack's key in the project scope. */
  readonly name: string;
  /** The folder itself, holding `archon-plugin.json`. */
  readonly dir: string;
}

/** A pack folder that also holds `.archon/workflows/<name>/`: two copies of one pack. */
export class AmbiguousSourcePackError extends Error {
  constructor(
    readonly packName: string,
    manifestFile: string,
    nested: string
  ) {
    super(
      `${manifestFile} makes this source pack '${packName}', and it also holds a copy of that ` +
        `pack at ${nested}. Neither copy is loaded. Remove one, or point at a directory that holds only one.`
    );
    this.name = 'AmbiguousSourcePackError';
  }
}

/**
 * The pack folder `dir` is, or null when its root has no plugin manifest or the manifest
 * is not a workflow pack. Every reader that maps a project source to its packs (discovery,
 * script discovery, `packDirectory`, the run capture), live or captured, asks this, so they
 * cannot disagree about what a pack folder is.
 *
 * Throws on an unreadable or invalid workflow-pack manifest, and when the folder also
 * holds `.archon/workflows/<name>/`: two copies of one pack in one source is ambiguous,
 * and picking one would run bytes the author did not choose.
 */
export async function sourcePackFolder(dir: string): Promise<SourcePackFolder | null> {
  const file = join(dir, PLUGIN_MANIFEST_FILE);
  let text: string;
  try {
    text = await readFile(file, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new Error(`Cannot read ${file}: ${(error as Error).message}`, { cause: error });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${(error as Error).message}`, { cause: error });
  }
  // A provider or forge plugin checkout is not a pack; its source reads as before.
  if (typeof raw !== 'object' || raw === null || !('kind' in raw) || raw.kind !== 'workflow-pack')
    return null;
  const parsed = workflowPackManifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid ${file}: ${describeIssues(parsed.error)}`);
  const { name } = parsed.data;
  const [workflowFolder] = archonPaths.getWorkflowFolderSearchPaths();
  const nested = join(dir, workflowFolder, name);
  if (await isDirectory(nested)) throw new AmbiguousSourcePackError(name, file, nested);
  return { name, dir };
}

/**
 * `sourcePackFolder` for a reader that resolves a loaded pack's files (commands, scripts,
 * `$PACK_DIR`). A folder whose manifest fails to read is no pack to it: discovery reports
 * that failure as the pack's load error, so the pack never loads and nothing resolves its
 * files, while the project's other packs and workflows still resolve.
 */
export async function loadablePackFolder(dir: string): Promise<SourcePackFolder | null> {
  try {
    return await sourcePackFolder(dir);
  } catch {
    return null;
  }
}

/** A `.env` file anywhere in the folder: secrets, never pack source. */
function isEnvFile(relPath: string): boolean {
  const name = basename(relPath);
  return name === '.env' || name.startsWith('.env.');
}

/**
 * The files a run's capture freezes from `dir` when it is a pack folder, or null when it is
 * not one. That is what an install of the folder would hold: in a git checkout, the tracked
 * files plus untracked ones git does not ignore, so a root `.env`, `node_modules` or build
 * output stay out; outside git, the whole tree. It never holds the folder's own `.archon/`,
 * whose source directories the capture freezes as for any project, or a `.env` file.
 *
 * A manifest that does not read as a pack (invalid, or ambiguous with a nested copy)
 * freezes only the manifest, so the captured read reports the load error live discovery
 * reports, and the project's other workflows still start.
 */
export async function sourcePackFiles(dir: string): Promise<TreeListing | null> {
  let pack: SourcePackFolder | null;
  try {
    pack = await sourcePackFolder(dir);
  } catch {
    // Discovery reports this same failure as a load error for the pack, from the copy.
    return listingOf(dir, [PLUGIN_MANIFEST_FILE]);
  }
  if (pack === null) return null;
  const relPaths = hasGitMarker(dir)
    ? await gitPackFiles(dir)
    : (await listTree(dir)).files.map(file => file.relPath);
  return listingOf(
    dir,
    relPaths.filter(path => path.split(/[\\/]/)[0] !== '.archon' && !isEnvFile(path))
  );
}

/** The folder's tracked files and the untracked ones git does not ignore, relative to it. */
async function gitPackFiles(dir: string): Promise<string[]> {
  const result = await runGit(dir, [
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
  ]);
  if (result.code !== 0) {
    throw new Error(`Cannot list the pack folder ${dir} with git (exit ${String(result.code)})`);
  }
  return [...new Set(result.stdout.toString('utf8').split('\0').filter(Boolean))];
}

/**
 * A listing of `relPaths` under `dir`. A path gone since git listed it (a tracked file
 * deleted in the checkout) is skipped; a directory (a submodule) is listed whole.
 */
async function listingOf(dir: string, relPaths: readonly string[]): Promise<TreeListing> {
  const dirs = new Set<string>(['']);
  const files: TreeFile[] = [];
  const add = (relPath: string, absPath: string, info: { size: number; mtimeMs: number }) => {
    files.push({ relPath, absPath, size: info.size, mtimeMs: info.mtimeMs });
    for (let parent = dirname(relPath); parent !== '.'; parent = dirname(parent)) dirs.add(parent);
  };
  for (const relPath of relPaths) {
    const absPath = join(dir, relPath);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(absPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (info.isDirectory()) {
      const nested = await listTree(absPath);
      for (const sub of nested.dirs) dirs.add(sub === '' ? relPath : join(relPath, sub));
      for (const file of nested.files) {
        if (!isEnvFile(file.relPath)) add(join(relPath, file.relPath), file.absPath, file);
      }
      continue;
    }
    if (info.isFile()) add(relPath, absPath, info);
  }
  return { dirs: [...dirs], files };
}
