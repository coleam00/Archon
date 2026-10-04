import { registerPlatformPolicy } from '../../platforms/registry';

export function registerTestPlatformPolicies(): void {
  registerPlatformPolicy({
    id: 'telegram',
    workspaceRetention: 'retain',
    streaming: { defaultMode: 'stream', envVar: 'TELEGRAM_STREAMING_MODE' },
  });
  registerPlatformPolicy({
    id: 'slack',
    workspaceRetention: 'age-based',
    streaming: { defaultMode: 'batch', envVar: 'SLACK_STREAMING_MODE' },
  });
  registerPlatformPolicy({
    id: 'discord',
    workspaceRetention: 'age-based',
    streaming: { defaultMode: 'batch', envVar: 'DISCORD_STREAMING_MODE' },
  });
}
