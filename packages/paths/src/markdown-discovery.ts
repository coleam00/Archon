/**
 * Discovery of command and workflow markdown files under `.archon/` folders.
 */

import { join, basename } from 'path';
import { readdir, realpath, stat } from 'fs/promises';

/**
 * Get command folder search paths for a repository
 * Returns folders in priority order (first match wins)
 *
 * Order:
 * 1. .archon/commands (always - user's custom commands, one subfolder deep)
 * 2. configuredFolder (if specified in config)
 *
 * @param configuredFolder - Optional additional folder from config
 */
export function getCommandFolderSearchPaths(configuredFolder?: string): string[] {
  const paths = ['.archon/commands'];

  // Add configured folder if specified (and not already in paths)
  if (configuredFolder && configuredFolder !== '.archon/commands') {
    paths.push(configuredFolder);
  }

  return paths;
}

/**
 * Get workflow folder search paths for a repository
 * Returns folders in priority order (first match wins)
 */
export function getWorkflowFolderSearchPaths(): string[] {
  return ['.archon/workflows'];
}

/**
 * Recursively find all .md files in a directory and its subdirectories.
 * Skips hidden directories and node_modules.
 *
 * `maxDepth` caps how many folders deep the walk descends. Depth is counted as
 * the number of folder boundaries between `rootPath` and the file — so at
 * `maxDepth: 1`, files at `rootPath/file.md` (depth 0) and `rootPath/group/file.md`
 * (depth 1) are included, but `rootPath/group/sub/file.md` (depth 2) is not.
 * Default is `Infinity` (no cap). Command consumers use `findCommandFiles`
 * to apply the executable-command depth and duplicate-selection policy.
 *
 * Results are in a defined order: siblings are visited in code-unit order by
 * name, and a directory's own results appear where that directory sorts among
 * its siblings. Callers may rely on the order being the same on every machine
 * and on every call; they must not sort again to obtain it.
 */
export async function findMarkdownFilesRecursive(
  rootPath: string,
  relativePath = '',
  options?: { maxDepth?: number; onMissing?: (path: string, error: unknown) => void }
): Promise<{ commandName: string; relativePath: string }[]> {
  return findMarkdownFilesRecursiveImpl(rootPath, relativePath, options, new Set<string>());
}

/** Discover executable commands in one scope: one folder deep, first name wins. */
export async function findCommandFiles(
  rootPath: string,
  onMissing?: (path: string, error: unknown) => void
): ReturnType<typeof findMarkdownFilesRecursive> {
  const entries = await findMarkdownFilesRecursive(rootPath, '', { maxDepth: 1, onMissing });
  const seen = new Set<string>();
  return entries.filter(({ commandName }) => {
    if (seen.has(commandName)) return false;
    seen.add(commandName);
    return true;
  });
}

function shouldSkipSymlinkTargetError(err: NodeJS.ErrnoException): boolean {
  return err.code === 'ENOENT' || err.code === 'ELOOP';
}

async function getEntryKind(
  entryPath: string,
  entry: { isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean },
  onMissing?: (path: string, error: unknown) => void
): Promise<'directory' | 'file' | 'other' | null> {
  if (entry.isSymbolicLink()) {
    try {
      const targetStat = await stat(entryPath);
      if (targetStat.isDirectory()) return 'directory';
      if (targetStat.isFile()) return 'file';
      return 'other';
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') onMissing?.(entryPath, e);
      if (shouldSkipSymlinkTargetError(err)) return null;
      throw err;
    }
  }

  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  return 'other';
}

async function getReachableRealPath(
  path: string,
  onMissing?: (path: string, error: unknown) => void
): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') onMissing?.(path, e);
    if (shouldSkipSymlinkTargetError(err)) return null;
    throw err;
  }
}

async function findMarkdownFilesRecursiveImpl(
  rootPath: string,
  relativePath: string,
  options: Parameters<typeof findMarkdownFilesRecursive>[2],
  visitedRealPaths: Set<string>
): Promise<{ commandName: string; relativePath: string }[]> {
  const maxDepth = options?.maxDepth ?? Infinity;
  const currentDepth = relativePath ? relativePath.split(/[/\\]/).filter(Boolean).length : 0;
  const results: { commandName: string; relativePath: string }[] = [];
  const fullPath = join(rootPath, relativePath);

  const entries = await readMarkdownDirectory(fullPath, visitedRealPaths, options?.onMissing);

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue;
    }

    const entryPath = join(fullPath, entry.name);
    const entryKind = await getEntryKind(entryPath, entry, options?.onMissing);
    if (entryKind === null) continue;

    if (entryKind === 'directory') {
      // Skip descending if we're already at the depth cap — files at deeper
      // levels are silently ignored (matches the convention that `.archon/*/`
      // folders support one level of grouping like `defaults/`).
      if (currentDepth >= maxDepth) continue;

      results.push(
        ...(await findMarkdownFilesInChild(
          rootPath,
          relativePath,
          entry.name,
          entryPath,
          options,
          visitedRealPaths
        ))
      );
    } else if (entryKind === 'file' && entry.name.endsWith('.md')) {
      results.push({
        commandName: basename(entry.name, '.md'),
        relativePath: join(relativePath, entry.name),
      });
    }
  }

  return results;
}

async function readMarkdownDirectory(
  fullPath: string,
  visitedRealPaths: Set<string>,
  onMissing?: (path: string, error: unknown) => void
) {
  if (visitedRealPaths.size === 0) {
    try {
      visitedRealPaths.add(await realpath(fullPath));
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        onMissing?.(fullPath, e);
        return [];
      }
      throw err;
    }
  }

  let entries;
  try {
    entries = await readdir(fullPath, { withFileTypes: true });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      onMissing?.(fullPath, e);
      return [];
    }
    throw err;
  }

  // `readdir` returns entries in filesystem order, which differs between
  // machines and can differ between calls on one machine. Every consumer of
  // this walk inherits that order, and `GET /api/commands` renders it to an
  // operator. Order is defined once here, at the only owner, rather than at
  // each call site. The comparison is on code units, not `localeCompare`,
  // so the result does not vary with the host locale.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return entries;
}

async function findMarkdownFilesInChild(
  rootPath: string,
  relativePath: string,
  name: string,
  entryPath: string,
  options: Parameters<typeof findMarkdownFilesRecursive>[2],
  visitedRealPaths: Set<string>
): ReturnType<typeof findMarkdownFilesRecursive> {
  const realChild = await getReachableRealPath(entryPath, options?.onMissing);
  if (!realChild) return [];
  if (visitedRealPaths.has(realChild)) return [];

  const childVisitedRealPaths = new Set(visitedRealPaths);
  childVisitedRealPaths.add(realChild);

  return findMarkdownFilesRecursiveImpl(
    rootPath,
    join(relativePath, name),
    options,
    childVisitedRealPaths
  );
}
