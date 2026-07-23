import { describe, test, expect } from 'bun:test';
import { resolveWorktreeEngine } from './resolve';
import { GitWorktreeEngine } from './git-engine';
import { WorktrunkEngine } from './worktrunk-engine';

describe('resolveWorktreeEngine', () => {
  test('undefined resolves to the default git engine', () => {
    expect(resolveWorktreeEngine(undefined)).toBeInstanceOf(GitWorktreeEngine);
  });

  test('empty string resolves to the default git engine', () => {
    expect(resolveWorktreeEngine('')).toBeInstanceOf(GitWorktreeEngine);
  });

  test('whitespace-only resolves to the default git engine', () => {
    expect(resolveWorktreeEngine('   ')).toBeInstanceOf(GitWorktreeEngine);
  });

  test("'git' resolves to GitWorktreeEngine", () => {
    expect(resolveWorktreeEngine('git')).toBeInstanceOf(GitWorktreeEngine);
  });

  test("'worktrunk' resolves to WorktrunkEngine", () => {
    expect(resolveWorktreeEngine('worktrunk')).toBeInstanceOf(WorktrunkEngine);
  });

  test('trims surrounding whitespace before matching', () => {
    expect(resolveWorktreeEngine('  worktrunk  ')).toBeInstanceOf(WorktrunkEngine);
  });

  test('unrecognized value throws rather than silently falling back to git', () => {
    expect(() => resolveWorktreeEngine('docker')).toThrow(/worktree\.engine must be one of/);
  });

  test('returns the same singleton instance across repeated calls (stateless engines)', () => {
    const first = resolveWorktreeEngine('worktrunk');
    const second = resolveWorktreeEngine('worktrunk');
    expect(first).toBe(second);
  });
});
