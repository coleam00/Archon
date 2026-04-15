import { describe, test, expect } from 'bun:test';
import { classifyIsolationError, isKnownIsolationError, IsolationBlockedError } from './errors';

describe('classifyIsolationError', () => {
  test('matches "permission denied" in message', () => {
    const result = classifyIsolationError(new Error('Permission denied: /workspace'));
    expect(result).toContain('Permission denied');
  });

  test('matches "eacces" in message', () => {
    const result = classifyIsolationError(new Error('EACCES: access denied'));
    expect(result).toContain('Permission denied');
  });

  test('matches "timeout" in message', () => {
    const result = classifyIsolationError(new Error('Command timeout after 30s'));
    expect(result).toContain('Timed out');
  });

  test('matches "no space left" in message', () => {
    const result = classifyIsolationError(new Error('No space left on device'));
    expect(result).toContain('No disk space');
  });

  test('matches "enospc" in message', () => {
    const result = classifyIsolationError(new Error('ENOSPC: write failed'));
    expect(result).toContain('No disk space');
  });

  test('matches "not a git repository" in message', () => {
    const result = classifyIsolationError(new Error('fatal: not a git repository'));
    expect(result).toContain('not a valid git repository');
  });

  test('returns generic message for unrecognized errors', () => {
    const result = classifyIsolationError(new Error('something unexpected'));
    expect(result).toContain('Could not create isolated workspace');
    expect(result).toContain('something unexpected');
  });

  test('checks stderr when message does not match', () => {
    const err = new Error('Command failed') as Error & { stderr: string };
    err.stderr = 'fatal: not a git repository';
    const result = classifyIsolationError(err);
    expect(result).toContain('not a valid git repository');
  });

  test('checks stderr for permission denied', () => {
    const err = new Error('git worktree add failed') as Error & { stderr: string };
    err.stderr = 'error: permission denied';
    const result = classifyIsolationError(err);
    expect(result).toContain('Permission denied');
  });

  test('handles missing stderr gracefully', () => {
    const result = classifyIsolationError(new Error('unknown error'));
    expect(result).toContain('Could not create isolated workspace');
  });

  test('matches "submodule initialization failed" with opt-out guidance', () => {
    const result = classifyIsolationError(
      new Error('Submodule initialization failed: fatal: could not read from remote repository')
    );
    expect(result).toContain('Submodule initialization failed');
    expect(result).toContain('initSubmodules: false');
  });
});

describe('isKnownIsolationError', () => {
  test('identifies permission denied as known', () => {
    expect(isKnownIsolationError(new Error('permission denied'))).toBe(true);
  });

  test('identifies eacces as known', () => {
    expect(isKnownIsolationError(new Error('EACCES: access denied'))).toBe(true);
  });

  test('identifies timeout as known', () => {
    expect(isKnownIsolationError(new Error('timeout after 30s'))).toBe(true);
  });

  test('identifies no space left as known', () => {
    expect(isKnownIsolationError(new Error('No space left on device'))).toBe(true);
  });

  test('identifies enospc as known', () => {
    expect(isKnownIsolationError(new Error('ENOSPC: write failed'))).toBe(true);
  });

  test('identifies not a git repository as known', () => {
    expect(isKnownIsolationError(new Error('fatal: not a git repository'))).toBe(true);
  });

  test('identifies branch not found as known', () => {
    expect(isKnownIsolationError(new Error('branch not found'))).toBe(true);
  });

  test('identifies submodule initialization failure as known', () => {
    expect(
      isKnownIsolationError(new Error('Submodule initialization failed: network unreachable'))
    ).toBe(true);
  });

  test('returns false for unknown errors', () => {
    expect(isKnownIsolationError(new TypeError('cannot read property of null'))).toBe(false);
  });

  test('returns false for generic unexpected errors', () => {
    expect(isKnownIsolationError(new Error('something unexpected'))).toBe(false);
  });

  test('checks stderr when message does not match', () => {
    const err = new Error('Command failed') as Error & { stderr: string };
    err.stderr = 'error: permission denied';
    expect(isKnownIsolationError(err)).toBe(true);
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
