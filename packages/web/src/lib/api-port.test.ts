import { describe, expect, test } from 'bun:test';
import { DEFAULT_API_PORT, resolveApiPort } from './api-port';

describe('resolveApiPort', () => {
  test('uses the server default when PORT is undefined', () => {
    expect(resolveApiPort(undefined)).toBe(DEFAULT_API_PORT);
  });

  test('uses the server default when PORT is blank', () => {
    expect(resolveApiPort('')).toBe(DEFAULT_API_PORT);
    expect(resolveApiPort('   ')).toBe(DEFAULT_API_PORT);
  });

  test('uses PORT from env when provided', () => {
    expect(resolveApiPort('3090')).toBe('3090');
  });
});
