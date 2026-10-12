import { beforeEach, expect, test } from 'bun:test';
import {
  clearPlatformPolicies,
  getRegisteredPlatformPolicies,
  retainsWorkspace,
  setPlatformPolicies,
} from '@archon/core/platforms/registry';
import { bundledPlatformPolicies, defaultPlatformPolicies } from './platform-policies';

beforeEach(clearPlatformPolicies);

test('bundled policies are valid and keep existing retention and streaming defaults', () => {
  setPlatformPolicies(bundledPlatformPolicies);
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
    { id: 'github', workspaceRetention: 'age-based' },
    { id: 'gitea', workspaceRetention: 'age-based' },
    { id: 'gitlab', workspaceRetention: 'age-based' },
  ]);
  expect(retainsWorkspace('telegram')).toBe(true);
});

test('default policies include the host surfaces before bundled platforms', () => {
  setPlatformPolicies(defaultPlatformPolicies);
  expect(getRegisteredPlatformPolicies()).toEqual([
    { id: 'cli', workspaceRetention: 'age-based' },
    { id: 'web', workspaceRetention: 'age-based' },
    { id: 'api', workspaceRetention: 'age-based' },
    ...bundledPlatformPolicies,
  ]);
});
