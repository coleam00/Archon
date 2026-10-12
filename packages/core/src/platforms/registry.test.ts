// @archon-test-isolated
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  clearPlatformPolicies,
  getRegisteredPlatformPolicies,
  retainsWorkspace,
  setPlatformPolicies,
  unknownPlatformReason,
} from './registry';

beforeEach(clearPlatformPolicies);

describe('platform policies', () => {
  test('retention is declared independently of a bundled platform name', () => {
    setPlatformPolicies([
      { id: 'matrix-chat', workspaceRetention: 'retain' },
      { id: 'new-forge', workspaceRetention: 'age-based' },
    ]);
    expect(retainsWorkspace('matrix-chat')).toBe(true);
    expect(retainsWorkspace('new-forge')).toBe(false);
    expect(retainsWorkspace('unknown')).toBe(false);
    expect(retainsWorkspace(null)).toBe(false);
  });

  test('retention fails until the host configures policies', () => {
    expect(() => retainsWorkspace(null)).toThrow('Platform policies are not configured');
    setPlatformPolicies([]);
    expect(retainsWorkspace('telegram')).toBe(false);
  });

  test('unknown-platform cleanup keeps legacy null rows distinct from missing policies', () => {
    expect(unknownPlatformReason(null)).toBeUndefined();
    expect(() => unknownPlatformReason('removed-chat')).toThrow(
      'Platform policies are not configured'
    );
    setPlatformPolicies([{ id: 'cli', workspaceRetention: 'age-based' }]);
    expect(unknownPlatformReason('cli')).toBeUndefined();
    expect(unknownPlatformReason('removed-chat')).toContain(
      "platform 'removed-chat' is not registered"
    );
  });

  test('a later call replaces the whole set', () => {
    setPlatformPolicies([{ id: 'matrix-chat', workspaceRetention: 'retain' }]);
    setPlatformPolicies([{ id: 'new-forge', workspaceRetention: 'age-based' }]);
    expect(getRegisteredPlatformPolicies().map(policy => policy.id)).toEqual(['new-forge']);
    expect(retainsWorkspace('matrix-chat')).toBe(false);
  });

  test('invalid or duplicate identifiers fail without changing the set', () => {
    setPlatformPolicies([{ id: 'matrix-chat', workspaceRetention: 'retain' }]);
    expect(() =>
      setPlatformPolicies([{ id: '../matrix', workspaceRetention: 'retain' }])
    ).toThrow();
    expect(() =>
      setPlatformPolicies([
        { id: 'new-forge', workspaceRetention: 'retain' },
        { id: 'new-forge', workspaceRetention: 'age-based' },
      ])
    ).toThrow("Duplicate platform policy for 'new-forge'");
    expect(getRegisteredPlatformPolicies().map(policy => policy.id)).toEqual(['matrix-chat']);
  });
});
