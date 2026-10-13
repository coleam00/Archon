import type { WorktreeCreateConfig } from './types';

export function validateWorktreePostCreate(config: WorktreeCreateConfig | null | undefined): void {
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
}
