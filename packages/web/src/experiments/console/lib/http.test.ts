import { describe, test, expect } from 'bun:test';
import { HttpError, errorDetail } from './http';

describe('errorDetail', () => {
  test('HttpError → parsed server message', () => {
    const err = new HttpError(403, '/api/workflows/foo', JSON.stringify({ error: 'denied' }));
    expect(errorDetail(err)).toBe('denied');
  });

  test('generic Error → message; non-Error → String()', () => {
    expect(errorDetail(new Error('boom'))).toBe('boom');
    expect(errorDetail(42)).toBe('42');
  });
});
