import { describe, expect, test } from 'bun:test';

import { parseCursorConfig } from './config';

describe('parseCursorConfig', () => {
  test('returns empty object for empty input', () => {
    expect(parseCursorConfig({})).toEqual({});
  });

  test('parses model and apiKey strings', () => {
    expect(parseCursorConfig({ model: 'composer-2.5', apiKey: 'key-123' })).toEqual({
      model: 'composer-2.5',
      apiKey: 'key-123',
    });
  });

  test('ignores invalid model types', () => {
    expect(parseCursorConfig({ model: 42 })).toEqual({});
  });

  test('parses mode and runtime enums', () => {
    expect(parseCursorConfig({ mode: 'plan', runtime: 'cloud' })).toEqual({
      mode: 'plan',
      runtime: 'cloud',
    });
    expect(parseCursorConfig({ mode: 'invalid' })).toEqual({});
  });

  test('parses modelParams object', () => {
    expect(parseCursorConfig({ modelParams: { thinking: 'high', bad: 1 } })).toEqual({
      modelParams: { thinking: 'high' },
    });
  });

  test('parses cloudRepos array', () => {
    expect(
      parseCursorConfig({
        cloudRepos: [{ url: 'https://github.com/org/repo', startingRef: 'main' }, { url: '' }],
      })
    ).toEqual({
      cloudRepos: [{ url: 'https://github.com/org/repo', startingRef: 'main' }],
    });
  });

  test('parses settingSources and enableSandbox', () => {
    expect(
      parseCursorConfig({ settingSources: ['project', 'user', 'nope'], enableSandbox: true })
    ).toEqual({
      settingSources: ['project', 'user'],
      enableSandbox: true,
    });
  });
});
