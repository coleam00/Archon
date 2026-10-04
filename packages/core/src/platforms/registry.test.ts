import { beforeEach, describe, expect, test } from 'bun:test';
import {
  clearPlatformPolicies,
  getRegisteredPlatformPolicies,
  registerPlatformPolicy,
  retainsWorkspace,
} from './registry';

beforeEach(clearPlatformPolicies);

describe('platform policies', () => {
  test('retention is declared independently of a bundled platform name', () => {
    registerPlatformPolicy({ id: 'matrix-chat', workspaceRetention: 'retain' });
    registerPlatformPolicy({ id: 'new-forge', workspaceRetention: 'age-based' });
    expect(retainsWorkspace('matrix-chat')).toBe(true);
    expect(retainsWorkspace('new-forge')).toBe(false);
    expect(retainsWorkspace('unknown')).toBe(false);
    expect(retainsWorkspace(null)).toBe(false);
    expect(getRegisteredPlatformPolicies().map(policy => policy.id)).toEqual([
      'matrix-chat',
      'new-forge',
    ]);
  });

  test('repeated identical declarations are accepted and conflicting declarations fail', () => {
    const policy = {
      id: 'matrix-chat',
      workspaceRetention: 'retain',
      streaming: { defaultMode: 'batch', envVar: 'MATRIX_STREAMING_MODE' },
    } as const;
    registerPlatformPolicy(policy);
    registerPlatformPolicy({ ...policy });
    expect(getRegisteredPlatformPolicies()).toHaveLength(1);
    expect(() => registerPlatformPolicy({ ...policy, workspaceRetention: 'age-based' })).toThrow(
      'Conflicting platform policy'
    );
    expect(() =>
      registerPlatformPolicy({
        ...policy,
        streaming: { ...policy.streaming, defaultMode: 'stream' },
      })
    ).toThrow('Conflicting platform policy');
    expect(() =>
      registerPlatformPolicy({
        ...policy,
        streaming: { ...policy.streaming, envVar: 'OTHER_MODE' },
      })
    ).toThrow('Conflicting platform policy');
  });

  test('invalid identifiers fail before registration', () => {
    expect(() =>
      registerPlatformPolicy({ id: '../matrix', workspaceRetention: 'retain' })
    ).toThrow();
    expect(getRegisteredPlatformPolicies()).toEqual([]);
  });
});
