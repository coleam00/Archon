import { describe, expect, test } from 'bun:test';
import { envPath, envPathKey } from './env-path';

describe('envPath', () => {
  test('reads a Path-only env, as Task Scheduler passes it', () => {
    expect(envPathKey({ Path: 'C:\\bin' })).toBe('Path');
    expect(envPath({ Path: 'C:\\bin' })).toBe('C:\\bin');
  });

  test('an exact PATH wins over a differently cased one', () => {
    expect(envPathKey({ Path: 'b', PATH: 'a' })).toBe('PATH');
    expect(envPath({ Path: 'b', PATH: 'a' })).toBe('a');
  });

  test('an env without one has no path', () => {
    expect(envPathKey({ HOME: '/home' })).toBe('PATH');
    expect(envPath({ HOME: '/home' })).toBeUndefined();
  });
});
