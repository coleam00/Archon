import { describe, expect, test } from 'bun:test';

import { parseOpencodeConfig, parseOpencodeModel } from './config';

describe('parseOpencodeConfig', () => {
  test('returns empty object for empty input', () => {
    expect(parseOpencodeConfig({})).toEqual({});
  });

  test('parses valid model string', () => {
    expect(parseOpencodeConfig({ model: 'ollama/qwen3:8b' })).toEqual({
      model: 'ollama/qwen3:8b',
    });
  });

  test('drops non-string model silently', () => {
    expect(parseOpencodeConfig({ model: 123 })).toEqual({});
    expect(parseOpencodeConfig({ model: null })).toEqual({});
    expect(parseOpencodeConfig({ model: [] })).toEqual({});
  });

  test('parses opencodeBinaryDir', () => {
    expect(parseOpencodeConfig({ opencodeBinaryDir: '/usr/local/bin' })).toEqual({
      opencodeBinaryDir: '/usr/local/bin',
    });
  });

  test('drops non-string opencodeBinaryDir silently', () => {
    expect(parseOpencodeConfig({ opencodeBinaryDir: 42 })).toEqual({});
  });

  test('parses model and opencodeBinaryDir together', () => {
    expect(
      parseOpencodeConfig({ model: 'anthropic/claude-sonnet-4-5', opencodeBinaryDir: '/opt/bin' })
    ).toEqual({ model: 'anthropic/claude-sonnet-4-5', opencodeBinaryDir: '/opt/bin' });
  });

  test('ignores unknown keys', () => {
    expect(parseOpencodeConfig({ model: 'ollama/qwen3:8b', futureField: 'x' })).toEqual({
      model: 'ollama/qwen3:8b',
    });
  });

  test('does not throw on malformed input', () => {
    expect(() => parseOpencodeConfig({ model: undefined })).not.toThrow();
    expect(() => parseOpencodeConfig({ model: {} })).not.toThrow();
  });
});

describe('parseOpencodeModel', () => {
  test('parses simple providerID/modelID', () => {
    expect(parseOpencodeModel('ollama/qwen3:8b')).toEqual({
      providerID: 'ollama',
      modelID: 'qwen3:8b',
    });
  });

  test('parses model with extra slashes in modelID', () => {
    expect(parseOpencodeModel('openrouter/meta-llama/llama-3')).toEqual({
      providerID: 'openrouter',
      modelID: 'meta-llama/llama-3',
    });
  });

  test('parses anthropic model', () => {
    expect(parseOpencodeModel('anthropic/claude-sonnet-4-5')).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4-5',
    });
  });

  test('returns undefined for missing slash', () => {
    expect(parseOpencodeModel('qwen3')).toBeUndefined();
  });

  test('returns undefined for leading slash', () => {
    expect(parseOpencodeModel('/model')).toBeUndefined();
  });

  test('returns undefined for trailing slash', () => {
    expect(parseOpencodeModel('ollama/')).toBeUndefined();
  });

  test('returns undefined for empty string', () => {
    expect(parseOpencodeModel('')).toBeUndefined();
  });
});
