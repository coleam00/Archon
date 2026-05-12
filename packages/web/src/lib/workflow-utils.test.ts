import { describe, test, expect } from 'bun:test';
import { isTerminalStatus } from './workflow-utils';

describe('isTerminalStatus', () => {
  test('completed is terminal', () => {
    expect(isTerminalStatus('completed')).toBe(true);
  });

  test('failed is terminal', () => {
    expect(isTerminalStatus('failed')).toBe(true);
  });

  test('cancelled is terminal', () => {
    expect(isTerminalStatus('cancelled')).toBe(true);
  });

  test('running is not terminal', () => {
    expect(isTerminalStatus('running')).toBe(false);
  });

  test('pending is not terminal', () => {
    expect(isTerminalStatus('pending')).toBe(false);
  });

  test('undefined is not terminal', () => {
    expect(isTerminalStatus(undefined)).toBe(false);
  });

  test('empty string is not terminal', () => {
    expect(isTerminalStatus('')).toBe(false);
  });
});
