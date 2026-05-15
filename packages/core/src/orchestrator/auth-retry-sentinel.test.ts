import { describe, expect, test } from 'bun:test';
import { AuthRefreshedRetryNeeded } from './auth-retry-sentinel';

describe('AuthRefreshedRetryNeeded', () => {
  test('extends Error', () => {
    const err = new AuthRefreshedRetryNeeded();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AuthRefreshedRetryNeeded);
  });

  test('has a stable name for instanceof + name checks', () => {
    const err = new AuthRefreshedRetryNeeded();
    expect(err.name).toBe('AuthRefreshedRetryNeeded');
  });

  test('carries a human-readable message but no token payload', () => {
    const err = new AuthRefreshedRetryNeeded();
    expect(err.message.length).toBeGreaterThan(0);
    // Must not include any token-prefix-like substring
    expect(err.message).not.toMatch(/sk-ant-|oat0|app_EMoam|sk-[A-Za-z0-9_]{20,}/);
  });

  test('is catchable with instanceof', () => {
    let caught: unknown;
    try {
      throw new AuthRefreshedRetryNeeded();
    } catch (err) {
      caught = err;
    }
    expect(caught instanceof AuthRefreshedRetryNeeded).toBe(true);
  });

  test('a plain Error is NOT an AuthRefreshedRetryNeeded', () => {
    const err = new Error('something');
    expect(err instanceof AuthRefreshedRetryNeeded).toBe(false);
  });
});
