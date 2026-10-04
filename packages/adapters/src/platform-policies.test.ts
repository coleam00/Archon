import { beforeEach, expect, test } from 'bun:test';
import {
  clearPlatformPolicies,
  getRegisteredPlatformPolicies,
  retainsWorkspace,
} from '@archon/core/platforms/registry';
import { registerBundledPlatformPolicies } from './platform-policies';

beforeEach(clearPlatformPolicies);

test('bundled metadata registers without constructing or starting any transport', () => {
  registerBundledPlatformPolicies();
  registerBundledPlatformPolicies();
  expect(getRegisteredPlatformPolicies()).toEqual([
    {
      id: 'telegram',
      workspaceRetention: 'retain',
      streaming: { defaultMode: 'stream', envVar: 'TELEGRAM_STREAMING_MODE' },
    },
    {
      id: 'slack',
      workspaceRetention: 'age-based',
      streaming: { defaultMode: 'batch', envVar: 'SLACK_STREAMING_MODE' },
    },
    {
      id: 'discord',
      workspaceRetention: 'age-based',
      streaming: { defaultMode: 'batch', envVar: 'DISCORD_STREAMING_MODE' },
    },
  ]);
  expect(retainsWorkspace('telegram')).toBe(true);
});
