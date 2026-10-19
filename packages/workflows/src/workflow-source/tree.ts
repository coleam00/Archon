import { copyFile, mkdir, readdir, realpath, stat } from 'fs/promises';
import type { Stats } from 'fs';
import { join, sep } from 'path';
import * as archonPaths from '@archon/paths';
import { isSystemError } from './integrity';
import { getLog } from './log';

/**
 * The only directories excluded from a capture.
 *
 * Deliberately tiny. An earlier version also skipped `node_modules`, `.venv`, and `venv`
 * on the theory that they are caches — but a packaged script may legitimately import from
 * a sibling `node_modules` or run against a checked-in virtualenv, so excluding them
 * produced a script that worked live and failed only once captured. Saving disk is not
 * worth breaking a workflow that runs today.
 *
 * What remains has to be provably not-executable-input:
 *  - `.git` is VCS metadata. Nothing reads it as source, and copying it can dwarf the
 *    tree it belongs to.
 *  - `__pycache__` is derived bytecode Python regenerates on demand. Copying it does not
 *    just waste space: stale `.pyc` files next to edited sources can change behavior.
 */
const SKIP_DIRECTORIES = new Set(['.git', '__pycache__']);

/** Project-relative directories that hold executable source. */
export function projectSourceDirs(commandFolder: string | undefined): string[] {
  return dedupeNestedDirs([
    ...archonPaths.getWorkflowFolderSearchPaths(),
    '.archon/scripts',
    ...archonPaths.getCommandFolderSearchPaths(commandFolder),
  ]);
}

/**
 * Drop any directory contained by another in the list, so nesting cannot produce a
 * duplicate copy. Compares on path segments rather than string prefixes: `.archon/cmd`
 * is not inside `.archon/c` even though one string starts with the other.
 */
function dedupeNestedDirs(dirs: readonly string[]): string[] {
  const normalized = [...new Set(dirs.map(d => d.split(/[\\/]/).filter(Boolean).join(sep)))];
  return normalized.filter(
    candidate =>
      !normalized.some(other => other !== candidate && (candidate + sep).startsWith(other + sep))
  );
}

/**
 * True when `path` exists and is a directory.
 *
 * `stat`, not `lstat`: a scope root is routinely a symlink — the dotfiles layout the
 * global-workflows guide recommends makes `~/.archon/workflows` one — and dropping it
 * here would silently omit that whole scope from the capture. This matches `listTree`
 * below, which dereferences symlinks on purpose.
 */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isSystemError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    throw error;
  }
}

/** A file found while walking a live source tree. */
export interface TreeFile {
  /** Path relative to the walked root, platform separator. */
  readonly relPath: string;
  readonly absPath: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * One live source tree, walked once.
 *
 * Listing before acting is what lets the bundled scope be checked for change and copied by
 * the same walk: the copy consumes the listing, and the cache compares two listings.
 */
export interface TreeListing {
  /** Every directory in the tree, relative to the root, `''` for the root itself. */
  readonly dirs: readonly string[];
  readonly files: readonly TreeFile[];
}

/**
 * Recursively list `root`, skipping cache directories.
 *
 * Directory symlinks are followed rather than preserved, so a link pointing at one of its
 * own ancestors would otherwise re-enter the same tree: the walk only stops when the kernel
 * refuses the path with ELOOP, by which point the same files have been visited a dozen-plus
 * times. `ancestors` holds the canonical (symlink-resolved) path of every directory open
 * above the current one, which cuts the cycle at the first repeat.
 */
export async function listTree(root: string): Promise<TreeListing> {
  const dirs: string[] = [];
  const files: TreeFile[] = [];

  const walk = async (dir: string, rel: string, ancestors: ReadonlySet<string>): Promise<void> => {
    dirs.push(rel);
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const absPath = join(dir, entry.name);
      const relPath = rel === '' ? entry.name : join(rel, entry.name);

      // Symlinks are DEREFERENCED into ordinary files. Preserving the link would keep a
      // live reference to a path outside the capture, which is the exact mutability this
      // module exists to remove. `stat` (not `lstat`) resolves the target; a dangling
      // link throws and is skipped rather than failing the whole capture.
      const info = await statOrSkip(absPath);
      if (info === undefined) continue;

      if (info.isDirectory()) {
        const canonical = await enterableDirectory(entry.name, absPath, ancestors);
        if (canonical !== undefined) {
          await walk(absPath, relPath, new Set([...ancestors, canonical]));
        }
        continue;
      }

      if (!info.isFile()) continue; // sockets, fifos, devices — nothing a workflow reads

      files.push({ relPath, absPath, size: info.size, mtimeMs: info.mtimeMs });
    }
  };

  // Seed the cycle guard with this root's canonical path so a link straight back to the
  // top of the tree is caught at depth one.
  const rootCanonical = await realpath(root).catch(() => root);
  await walk(root, '', new Set([rootCanonical]));
  return { dirs, files };
}

async function statOrSkip(absPath: string): Promise<Stats | undefined> {
  try {
    return await stat(absPath);
  } catch (error) {
    getLog().warn({ err: error as Error, path: absPath }, 'workflow.source_capture_entry_skipped');
    return undefined;
  }
}

/** The canonical path to descend into, or `undefined` for a directory the walk skips. */
async function enterableDirectory(
  name: string,
  absPath: string,
  ancestors: ReadonlySet<string>
): Promise<string | undefined> {
  if (SKIP_DIRECTORIES.has(name)) return undefined;
  let canonical: string;
  try {
    canonical = await realpath(absPath);
  } catch (error) {
    getLog().warn({ err: error as Error, path: absPath }, 'workflow.source_capture_entry_skipped');
    return undefined;
  }
  if (ancestors.has(canonical)) {
    // A link back into a directory we are already inside. Copying it would duplicate
    // that subtree under itself, so record it and move on.
    getLog().warn({ path: absPath, canonical }, 'workflow.source_capture_cycle_skipped');
    return undefined;
  }
  return canonical;
}

/** Copy a listed tree into `to`. Empty directories are recreated too. */
export async function copyListing(
  listing: TreeListing,
  to: string
): Promise<{ files: number; bytes: number }> {
  for (const dir of listing.dirs) await mkdir(join(to, dir), { recursive: true });
  let bytes = 0;
  for (const file of listing.files) {
    await copyFile(file.absPath, join(to, file.relPath));
    bytes += file.size;
  }
  return { files: listing.files.length, bytes };
}
