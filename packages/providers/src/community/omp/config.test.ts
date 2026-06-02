import { describe, expect, test } from 'bun:test';

import { parseOmpConfig } from './config';

describe('parseOmpConfig', () => {
  test('parses valid model string', () => {
    expect(parseOmpConfig({ model: 'cursor/composer-2.5' })).toEqual({
      model: 'cursor/composer-2.5',
    });
  });

  test('drops invalid model type silently', () => {
    expect(parseOmpConfig({ model: 123 })).toEqual({});
  });

  test('parses enableExtensions and interactive', () => {
    expect(parseOmpConfig({ enableExtensions: true, interactive: true })).toEqual({
      enableExtensions: true,
      interactive: true,
    });
  });

  test('returns empty object for undefined input', () => {
    expect(parseOmpConfig(undefined)).toEqual({});
  });
});
