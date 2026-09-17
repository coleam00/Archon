import { describe, expect, test } from 'bun:test';
import { buildGrokEnv } from './env';

describe('buildGrokEnv', () => {
  test('strips API key vars even when requested', () => {
    const env = buildGrokEnv({
      XAI_API_KEY: 'nope',
      GROK_CODE_XAI_API_KEY: 'nope',
      GROK_API_KEY: 'nope',
      PATH: '/bin',
    });
    expect(env.XAI_API_KEY).toBeUndefined();
    expect(env.GROK_CODE_XAI_API_KEY).toBeUndefined();
    expect(env.GROK_API_KEY).toBeUndefined();
    expect(env.GROK_DISABLE_API_KEY_AUTH).toBe('1');
    expect(env.GROK_DISABLE_AUTOUPDATER).toBe('1');
    expect(env.PATH).toBe('/bin');
  });
});
