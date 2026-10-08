import type { PlatformPolicy } from '@archon/core/platforms/types';

export const cliPolicy = {
  id: 'cli',
  workspaceRetention: 'age-based',
} as const satisfies PlatformPolicy;
