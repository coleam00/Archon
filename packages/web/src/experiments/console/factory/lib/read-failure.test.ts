import { describe, expect, test } from 'bun:test';
import { HttpError } from '../../lib/http';
import { readFailure } from './read-failure';

describe('readFailure', () => {
  test('a request that got no answer says the server did not answer, whatever its text', () => {
    expect(readFailure(new TypeError('Failed to fetch'))).toBe('the server did not answer');
    expect(readFailure(new TypeError('NetworkError when attempting to fetch resource.'))).toBe(
      'the server did not answer'
    );
  });

  test("an answer with the server's message says that message", () => {
    const error = new HttpError(
      500,
      '/api/factory/item',
      '{"error":"x"}',
      'Failed to read the item'
    );
    expect(readFailure(error)).toBe('Failed to read the item');
  });

  test('an answer with no message says its status, not the raw error text', () => {
    expect(readFailure(new HttpError(502, '/api/factory/item', ''))).toBe('Request failed (502)');
  });

  test('any other error says its own text', () => {
    expect(readFailure(new Error('The answer was not JSON'))).toBe('The answer was not JSON');
  });
});
