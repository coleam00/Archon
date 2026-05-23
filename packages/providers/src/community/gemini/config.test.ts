import { describe, expect, test } from 'bun:test';

import { parseGeminiConfig } from './config';

describe('parseGeminiConfig', () => {
  test('parses valid model string', () => {
    expect(parseGeminiConfig({ model: 'gemini-2.5-pro' })).toEqual({ model: 'gemini-2.5-pro' });
  });

  test('drops invalid model type silently', () => {
    expect(parseGeminiConfig({ model: 123 })).toEqual({});
  });

  test('ignores unknown keys', () => {
    expect(parseGeminiConfig({ futureField: 'x', model: 'gemini-2.5-pro' })).toEqual({
      model: 'gemini-2.5-pro',
    });
  });

  test('returns empty object for empty input', () => {
    expect(parseGeminiConfig({})).toEqual({});
  });

  test('does not throw on malformed input', () => {
    expect(() => parseGeminiConfig({ model: null })).not.toThrow();
    expect(() => parseGeminiConfig({ model: [] })).not.toThrow();
  });

  test('parses geminiBinaryPath', () => {
    expect(parseGeminiConfig({ geminiBinaryPath: '/usr/local/bin/gemini' })).toEqual({
      geminiBinaryPath: '/usr/local/bin/gemini',
    });
  });

  test('drops non-string geminiBinaryPath silently', () => {
    expect(parseGeminiConfig({ geminiBinaryPath: 42 })).toEqual({});
    expect(parseGeminiConfig({ geminiBinaryPath: null })).toEqual({});
  });

  test('parses model and geminiBinaryPath together', () => {
    expect(
      parseGeminiConfig({ model: 'gemini-2.5-flash', geminiBinaryPath: '/usr/bin/gemini' })
    ).toEqual({ model: 'gemini-2.5-flash', geminiBinaryPath: '/usr/bin/gemini' });
  });
});
