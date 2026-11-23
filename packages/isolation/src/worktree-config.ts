import { normalize } from 'path';

import type { WorktreeCreateConfig } from './types';

/** Throws when a `worktree:` value would make worktree setup misbehave. */
export function validateWorktreeConfig(config: WorktreeCreateConfig | null | undefined): void {
  if (
    config?.postCreate !== undefined &&
    (!Array.isArray(config.postCreate) ||
      config.postCreate.some(command => typeof command !== 'string' || command.trim().length === 0))
  ) {
    throw new Error('worktree.postCreate must be an array of non-empty command strings');
  }
  if (
    config?.postCreateTimeout !== undefined &&
    (!Number.isSafeInteger(config.postCreateTimeout) || config.postCreateTimeout <= 0)
  ) {
    throw new Error('worktree.postCreateTimeout must be a positive safe integer in milliseconds');
  }
  const linkFiles = config?.linkFiles;
  if (linkFiles === undefined) return;
  if (
    !Array.isArray(linkFiles) ||
    linkFiles.some(entry => typeof entry !== 'string' || entry.trim().length === 0)
  ) {
    throw new Error('worktree.linkFiles must be an array of non-empty path strings');
  }
  // A path both copied and linked has no single meaning. Copying runs first, so a
  // copy at, inside or above a linked path puts a real directory where the link
  // belongs, and the link step then finds the destination taken: the operator
  // silently gets a copy.
  const copied = Array.isArray(config?.copyFiles) ? config.copyFiles.map(pathSegments) : [];
  const conflicts = linkFiles.filter(entry => {
    const linked = pathSegments(entry);
    return copied.some(copy => startsWith(copy, linked) || startsWith(linked, copy));
  });
  if (conflicts.length > 0) {
    throw new Error(
      `worktree.linkFiles lists ${conflicts.join(', ')}, which overlaps a worktree.copyFiles path (the same path, inside it or containing it); keep each path in one list`
    );
  }
}

function pathSegments(entry: unknown): string[] {
  if (typeof entry !== 'string') return [];
  return normalize(entry.trim())
    .split(/[\\/]/)
    .filter(segment => segment !== '' && segment !== '.');
}

/** Whether `path` is `prefix` or lies below it. An empty path (not a string) matches nothing. */
function startsWith(path: string[], prefix: string[]): boolean {
  return prefix.length > 0 && prefix.every((segment, index) => path[index] === segment);
}
