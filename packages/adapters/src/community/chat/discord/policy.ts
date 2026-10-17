import type { PlatformPolicy } from '@archon/core/platforms/types';

export const discordPolicy = {
  id: 'discord',
  workspaceRetention: 'age-based',
  streaming: { defaultMode: 'batch', envVar: 'DISCORD_STREAMING_MODE' },
} as const satisfies PlatformPolicy;
