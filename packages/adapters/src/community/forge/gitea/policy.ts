import type { PlatformPolicy } from '@archon/core/platforms/types';

export const giteaPolicy = {
  id: 'gitea',
  workspaceRetention: 'age-based',
} as const satisfies PlatformPolicy;
