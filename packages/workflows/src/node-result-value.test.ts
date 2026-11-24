import { describe, expect, test } from 'bun:test';
import { nodeResultValue } from './node-result-value';

describe('nodeResultValue', () => {
  test('recorded structured output wins over text', () => {
    expect(nodeResultValue({ admit: 'ask' }, '{"admit":"auto"}')).toEqual({ admit: 'ask' });
    // A structured value that is itself a string stays that string, unparsed.
    expect(nodeResultValue('{"a":1}', 'x')).toBe('{"a":1}');
  });

  test('without structured output, text that is JSON is its value', () => {
    expect(nodeResultValue(undefined, '{"declared":4,"failed":[]}')).toEqual({
      declared: 4,
      failed: [],
    });
  });

  test('text that is not JSON, or no text, has no value', () => {
    expect(nodeResultValue(undefined, 'Filed one finding.')).toBeUndefined();
    expect(nodeResultValue(undefined, undefined)).toBeUndefined();
  });
});
