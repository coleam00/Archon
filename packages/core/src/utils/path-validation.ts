/**
 * Path validation utilities to prevent path traversal attacks
 */
import { resolve, sep } from 'path';
import { getArchonWorkspacesPath } from '@archon/paths';

// Lazy evaluation to allow tests to modify env vars
function getWorkspaceRoot(): string {
  return resolve(getArchonWorkspacesPath());
}

/**
 * Validates that a resolved path stays within the allowed workspace directory.
 * Prevents path traversal attacks using sequences like "../"
 *
 * @param targetPath - The path to validate (can be absolute or relative)
 * @param basePath - Optional base path to resolve relative paths against (defaults to workspace root)
 * @returns true if path is within workspace, false otherwise
 */
export function isPathWithinWorkspace(targetPath: string, basePath?: string): boolean {
  const workspaceRoot = getWorkspaceRoot();
  const effectiveBase = basePath ?? workspaceRoot;
  const resolvedTarget = resolve(effectiveBase, targetPath);
  return resolvedTarget === workspaceRoot || resolvedTarget.startsWith(workspaceRoot + sep);
}

/**
 * Validates a path and returns the resolved absolute path if valid.
 * Throws an error if the path escapes the workspace.
 *
 * @param targetPath - The path to validate
 * @param basePath - Optional base path to resolve relative paths against
 * @returns The resolved absolute path
 * @throws Error if path is outside workspace
 */
export function validateAndResolvePath(targetPath: string, basePath?: string): string {
  const workspaceRoot = getWorkspaceRoot();
  const effectiveBase = basePath ?? workspaceRoot;
  const resolvedPath = resolve(effectiveBase, targetPath);

  if (!isPathWithinWorkspace(resolvedPath)) {
    throw new Error(`Path must be within ${workspaceRoot} directory`);
  }

  return resolvedPath;
}
