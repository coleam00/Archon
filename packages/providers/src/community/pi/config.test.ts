import { describe, expect, test } from 'bun:test';

import { parsePiConfig } from './config';

describe('parsePiConfig', () => {
  test('parses valid model string', () => {
    expect(parsePiConfig({ model: 'google/gemini-2.5-pro' })).toEqual({
      model: 'google/gemini-2.5-pro',
    });
  });

  test('drops invalid model type silently', () => {
    expect(parsePiConfig({ model: 123 })).toEqual({});
  });

  test('ignores unknown keys', () => {
    expect(parsePiConfig({ futureField: 'x', model: 'google/gemini-2.5-pro' })).toEqual({
      model: 'google/gemini-2.5-pro',
    });
  });

  test('returns empty object for empty input', () => {
    expect(parsePiConfig({})).toEqual({});
  });

  test('does not throw on malformed input', () => {
    expect(() => parsePiConfig({ model: null })).not.toThrow();
    expect(() => parsePiConfig({ model: [] })).not.toThrow();
  });
});
