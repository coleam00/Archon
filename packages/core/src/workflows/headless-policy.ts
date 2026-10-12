import type { PlatformPolicy } from '../platforms/types';

export const apiPolicy = {
  id: 'api',
  workspaceRetention: 'age-based',
} as const satisfies PlatformPolicy;
