import type { PlatformPolicy } from '@archon/core/platforms/types';

export const telegramPolicy = {
  id: 'telegram',
  workspaceRetention: 'retain',
  streaming: { defaultMode: 'stream', envVar: 'TELEGRAM_STREAMING_MODE' },
} as const satisfies PlatformPolicy;
