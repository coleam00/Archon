import type { PlatformPolicy } from '@archon/core/platforms/types';

export const slackPolicy = {
  id: 'slack',
  workspaceRetention: 'age-based',
  streaming: { defaultMode: 'batch', envVar: 'SLACK_STREAMING_MODE' },
} as const satisfies PlatformPolicy;
