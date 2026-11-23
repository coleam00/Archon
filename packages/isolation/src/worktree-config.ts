import { normalize, sep } from 'path';

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
  // A path both copied and linked has no single meaning: the copy lands first and
  // the link then finds the destination taken, so the operator silently gets a copy.
  const copied = new Set(
    Array.isArray(config?.copyFiles) ? config.copyFiles.map(comparablePath) : []
  );
  const both = linkFiles.filter(entry => copied.has(comparablePath(entry)));
  if (both.length > 0) {
    throw new Error(
      `worktree.linkFiles and worktree.copyFiles both list ${both.join(', ')}; keep each path in one list`
    );
  }
}

function comparablePath(entry: unknown): string {
  if (typeof entry !== 'string') return '';
  const normalized = normalize(entry.trim());
  return normalized.endsWith(sep) && normalized.length > 1 ? normalized.slice(0, -1) : normalized;
}
