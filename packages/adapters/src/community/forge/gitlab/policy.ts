import type { PlatformPolicy } from '@archon/core/platforms/types';

export const gitlabPolicy = {
  id: 'gitlab',
  workspaceRetention: 'age-based',
} as const satisfies PlatformPolicy;
