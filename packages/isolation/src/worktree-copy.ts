/**
 * Worktree file copy utility
 *
 * Copies git-ignored files from the canonical repo to a new worktree
 * based on configuration in .archon/config.yaml
 */

import { copyFile, cp, stat, mkdir } from 'fs/promises';
import { join, dirname, relative, isAbsolute, normalize } from 'path';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('worktree-copy');
  return cachedLog;
}

export interface CopyFileEntry {
  source: string;
  destination: string;
}

/**
 * Parse a copy file entry from config.
 * Each entry is a path to a git-ignored file or directory to copy into worktrees.
 *
 * @param entry - Config entry like ".env" or "data/fixtures/"
 * @returns Parsed source and destination (always identical)
 * @throws Error if entry is empty
 */
export function parseCopyFileEntry(entry: string): CopyFileEntry {
  const trimmed = entry.trim();

  if (!trimmed) {
    throw new Error('Copy entry cannot be empty');
  }

  return { source: trimmed, destination: trimmed };
}

/**
 * Check if a path escapes its root directory (path traversal attack)
 * Works on both Unix and Windows paths
 *
 * @param root - The root directory path
 * @param filePath - The relative file path to check
 * @returns true if path stays within root, false if it escapes
 */
export function isPathWithinRoot(root: string, filePath: string): boolean {
  // Join and normalize to resolve any ../ segments
  const fullPath = normalize(join(root, filePath));
  const normalizedRoot = normalize(root);

  // Get relative path from root to fullPath
  const relativePath = relative(normalizedRoot, fullPath);

  // If relative path starts with '..' or is absolute, it escapes the root
  // On Windows, cross-drive paths will be absolute (e.g., "D:\other")
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return false;
  }

  return true;
}

/**
 * Copy a single file or directory from source repo to worktree
 *
 * @param sourceRoot - Canonical repo path
 * @param destRoot - Worktree path
 * @param entry - Parsed copy file entry
 * @returns true if copied successfully, false if:
 *   - Source doesn't exist (ENOENT) - expected, silently skipped
 *   - Path traversal detected - security violation, logged as error
 *   - Other errors (permissions, disk full, etc.) - logged as error
 */
export async function copyWorktreeFile(
  sourceRoot: string,
  destRoot: string,
  entry: CopyFileEntry
): Promise<boolean> {
  // Security: Validate paths don't escape their roots (prevents path traversal)
  if (!isPathWithinRoot(sourceRoot, entry.source)) {
    getLog().error(
      { source: entry.source, sourceRoot, reason: 'Source path escapes repository root' },
      'path_traversal_blocked'
    );
    return false;
  }

  if (!isPathWithinRoot(destRoot, entry.destination)) {
    getLog().error(
      {
        destination: entry.destination,
        destRoot,
        reason: 'Destination path escapes worktree root',
      },
      'path_traversal_blocked'
    );
    return false;
  }

  const sourcePath = join(sourceRoot, entry.source);
  const destPath = join(destRoot, entry.destination);

  try {
    const stats = await stat(sourcePath);

    // Ensure destination directory exists
    await mkdir(dirname(destPath), { recursive: true });

    if (stats.isDirectory()) {
      // Copy directory recursively
      await cp(sourcePath, destPath, { recursive: true });
    } else {
      // Copy single file
      await copyFile(sourcePath, destPath);
    }

    getLog().debug({ source: entry.source, destination: entry.destination }, 'file_copied');
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;

    if (err.code === 'ENOENT') {
      // Source doesn't exist - expected case, skip silently
      // This matches worktree-manager skill behavior
      getLog().debug({ source: entry.source }, 'file_skipped_not_found');
      return false;
    }

    // Unexpected error - log with full context for debugging
    getLog().error(
      {
        source: entry.source,
        destination: entry.destination,
        sourcePath,
        destPath,
        err,
        code: err.code ?? 'UNKNOWN',
      },
      'copy_failed'
    );
    return false;
  }
}

/**
 * Copy all configured files from canonical repo to worktree
 *
 * @param canonicalRepoPath - Path to the main repository
 * @param worktreePath - Path to the new worktree
 * @param copyFiles - Array of file paths from config
 * @returns Array of successfully copied entries
 */
export async function copyWorktreeFiles(
  canonicalRepoPath: string,
  worktreePath: string,
  copyFiles: string[]
): Promise<CopyFileEntry[]> {
  const copied: CopyFileEntry[] = [];

  for (const fileConfig of copyFiles) {
    try {
      const entry = parseCopyFileEntry(fileConfig);
      const success = await copyWorktreeFile(canonicalRepoPath, worktreePath, entry);
      if (success) {
        copied.push(entry);
      }
    } catch (parseError) {
      // Invalid config entry - log and continue with other entries
      const err = parseError as Error;
      getLog().error({ entry: fileConfig, err }, 'invalid_config_entry');
    }
  }

  return copied;
}
