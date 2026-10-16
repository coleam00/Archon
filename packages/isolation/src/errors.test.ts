import { GitFailure, ConfiguredBaseBranchNotFoundError } from '@archon/git';
import { describe, test, expect } from 'bun:test';
import {
  classifyIsolationError,
  ExistingBranchDivergedError,
  isKnownIsolationError,
  IsolationBlockedError,
  IsolationFailure,
  recordCleanupFailure,
  WorktreePostCreateError,
  MissingProjectDirectoryError,
} from './errors';

test('missing project guidance survives isolation classification even with timeout in its path', () => {
  const error = new MissingProjectDirectoryError('/workspace/timeout/source', 'acme/timeout');
  expect(isKnownIsolationError(error)).toBe(true);
  expect(classifyIsolationError(error)).toBe(`**Error:** ${error.message}`);
});

test('a diverged branch is reported as itself even when its name contains timeout', () => {
  const error = new ExistingBranchDivergedError(
    'fix/timeout-retry',
    'origin/fix/timeout-retry',
    1,
    2
  );
  expect(isKnownIsolationError(error)).toBe(true);
  expect(classifyIsolationError(error)).toBe(`**Error:** ${error.message}`);
});

describe('typed isolation failures', () => {
  test.each([
    ['permission_denied', 'Permission denied'],
    ['timeout', 'Timed out'],
    ['no_space', 'No disk space'],
    ['not_repository', 'not a valid git repository'],
    ['default_branch_missing', 'No base branch could be detected'],
    ['submodule_failed', 'initSubmodules: false'],
    ['adoption_refused', 'Refused to adopt'],
    ['ownership_unverified', 'Cannot verify ownership'],
    ['different_clone', 'different local clone'],
  ] as const)('%s selects its message regardless of branch text', (kind, message) => {
    const error = new IsolationFailure(
      kind,
      'timeout permission denied cannot adopt /fix/no-space'
    );
    expect(isKnownIsolationError(error)).toBe(true);
    expect(classifyIsolationError(error)).toContain(message);
  });

  test.each([
    'permission denied',
    'EACCES',
    'timeout',
    'no space left',
    'not a git repository',
    'cannot adopt',
  ])('plain text %s never turns an unexpected error into a blocked failure', text => {
    const error = new TypeError(`Unexpected bug in branch ${text}`);
    expect(isKnownIsolationError(error)).toBe(false);
    expect(classifyIsolationError(error)).toContain(error.message);
  });

  test('unclassified git failure retains operation, full stderr, exit code and cause through wrappers', () => {
    const cause = Object.assign(new Error('git worktree add failed'), {
      code: 128,
      stderr: 'permission denied\nsecond line: timeout',
    });
    const failure = new GitFailure('unclassified', cause.message, cause);
    const wrapped = new Error(`Failed to create PR worktree: ${failure.message}`, {
      cause: failure,
    });
    expect(isKnownIsolationError(wrapped)).toBe(false);
    expect(classifyIsolationError(wrapped)).toContain('git worktree add');
    expect(classifyIsolationError(wrapped)).toContain(cause.stderr);
    expect(classifyIsolationError(wrapped)).toContain('exit code 128');
    expect(classifyIsolationError(wrapped)).not.toContain('Timed out');
    expect(failure.cause).toBe(cause);
  });

  test.each([
    ['EACCES', 'Permission denied'],
    ['ENOSPC', 'No disk space'],
    ['ETIMEDOUT', 'Timed out'],
  ] as const)('classifies structured errno %s through context wrappers', (code, message) => {
    const failure = new Error('Cannot inspect path containing timeout', {
      cause: new IsolationFailure(
        'unclassified',
        'process failure',
        Object.assign(new Error('arbitrary vendor wording'), { code })
      ),
    });
    expect(isKnownIsolationError(failure)).toBe(true);
    expect(classifyIsolationError(failure)).toContain(message);
  });

  test('configured missing branch keeps its corrective guidance', () => {
    const failure = new ConfiguredBaseBranchNotFoundError('fix/timeout-retry', 'origin');
    expect(classifyIsolationError(failure)).toBe(`**Error:** ${failure.message}`);
    expect(isKnownIsolationError(failure)).toBe(true);
  });

  test('post-create command evidence outranks its underlying errno', () => {
    const failure = new WorktreePostCreateError(
      0,
      'install',
      'exit',
      'failed',
      7,
      undefined,
      undefined,
      Object.assign(new Error('permission denied'), { code: 'EACCES' })
    );
    expect(classifyIsolationError(failure)).toBe(`**Error:** ${failure.message}`);
  });

  test('cleanup evidence cannot override the original failure', () => {
    const failure = new IsolationFailure(
      'branch_exists',
      'Branch "fix/timeout-retry" already exists'
    );
    recordCleanupFailure(failure, 'Cleanup failed: permission denied');
    expect(classifyIsolationError(failure)).toBe(
      '**Error:** Branch "fix/timeout-retry" already exists Cleanup failed: permission denied'
    );
  });
});

describe('IsolationBlockedError', () => {
  test('has correct name', () => {
    const err = new IsolationBlockedError('blocked', 'creation_failed');
    expect(err.name).toBe('IsolationBlockedError');
  });

  test('has correct reason', () => {
    const err = new IsolationBlockedError('blocked', 'creation_failed');
    expect(err.reason).toBe('creation_failed');
  });

  test('is instanceof Error', () => {
    const err = new IsolationBlockedError('blocked', 'creation_failed');
    expect(err).toBeInstanceOf(Error);
  });

  test('has correct message', () => {
    const err = new IsolationBlockedError('test message', 'creation_failed');
    expect(err.message).toBe('test message');
  });
});
