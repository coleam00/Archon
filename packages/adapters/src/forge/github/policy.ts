import type { PlatformPolicy } from '@archon/core/platforms/types';

export const githubPolicy = {
  id: 'github',
  workspaceRetention: 'age-based',
} as const satisfies PlatformPolicy;
