import { describe, test, expect } from 'bun:test';
import { toError } from './error';

describe('toError', () => {
  test('returns Error instances unchanged', () => {
    const err = new Error('test');
    expect(toError(err)).toBe(err);
  });

  test('preserves Error subclass instances', () => {
    class CustomError extends Error {
      code = 42;
    }
    const err = new CustomError('custom');
    const result = toError(err);
    expect(result).toBe(err);
    expect(result).toBeInstanceOf(CustomError);
  });

  test('wraps string in Error', () => {
    const result = toError('something broke');
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('something broke');
  });

  test('wraps empty string in Error', () => {
    const result = toError('');
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('');
  });

  test('serializes objects via JSON.stringify', () => {
    const result = toError({ code: 404, detail: 'not found' });
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toContain('404');
    expect(result.message).toContain('not found');
  });

  test('handles null', () => {
    const result = toError(null);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('null');
  });

  test('handles undefined', () => {
    const result = toError(undefined);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('undefined');
  });

  test('handles numeric values', () => {
    const result = toError(42);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('42');
  });

  test('handles boolean values', () => {
    const result = toError(false);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('false');
  });

  test('falls back to String() for circular references', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = toError(circular);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBeTruthy();
  });
});
