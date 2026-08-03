import { describe, expect, test } from 'bun:test';
import { resolveChatHeaderPath } from './chat-header';

describe('resolveChatHeaderPath', () => {
  test('prefers the workflow run cwd override over the conversation cwd', () => {
    expect(resolveChatHeaderPath('/worktrees/parent', '/worktrees/worker')).toBe(
      '/worktrees/worker'
    );
  });

  test('falls back to the conversation cwd when no override is available', () => {
    expect(resolveChatHeaderPath('/worktrees/parent', null)).toBe('/worktrees/parent');
    expect(resolveChatHeaderPath('/worktrees/parent', undefined)).toBe('/worktrees/parent');
  });

  test('returns undefined when neither path is available', () => {
    expect(resolveChatHeaderPath(null, undefined)).toBeUndefined();
  });
});
