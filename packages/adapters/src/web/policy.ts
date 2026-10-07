import type { PlatformPolicy } from '@archon/core/platforms/types';

export const webPolicy = {
  id: 'web',
  workspaceRetention: 'age-based',
} as const satisfies PlatformPolicy;
