import { describe, expect, test } from 'bun:test';

import { isPiModelCompatible, parsePiModelRef } from './model-ref';

describe('parsePiModelRef', () => {
  test('parses simple provider/model', () => {
    expect(parsePiModelRef('google/gemini-2.5-pro')).toEqual({
      provider: 'google',
      modelId: 'gemini-2.5-pro',
    });
  });

  test('preserves nested slashes in modelId (OpenRouter style)', () => {
    expect(parsePiModelRef('openrouter/qwen/qwen3-coder')).toEqual({
      provider: 'openrouter',
      modelId: 'qwen/qwen3-coder',
    });
  });

  test('accepts hyphens and digits in provider slug', () => {
    expect(parsePiModelRef('google-vertex/gemini-2.5-pro')).toEqual({
      provider: 'google-vertex',
      modelId: 'gemini-2.5-pro',
    });
  });

  test('rejects empty provider', () => {
    expect(parsePiModelRef('/model')).toBeUndefined();
  });

  test('rejects empty modelId', () => {
    expect(parsePiModelRef('provider/')).toBeUndefined();
  });

  test('rejects missing slash', () => {
    expect(parsePiModelRef('sonnet')).toBeUndefined();
  });

  test('rejects uppercase provider', () => {
    expect(parsePiModelRef('Google/gemini')).toBeUndefined();
  });

  test('rejects provider starting with digit', () => {
    expect(parsePiModelRef('3m/foo')).toBeUndefined();
  });

  test('rejects empty string', () => {
    expect(parsePiModelRef('')).toBeUndefined();
  });
});

describe('isPiModelCompatible', () => {
  test('accepts valid provider/model refs', () => {
    expect(isPiModelCompatible('google/gemini-2.5-pro')).toBe(true);
    expect(isPiModelCompatible('anthropic/claude-opus-4-5')).toBe(true);
    expect(isPiModelCompatible('openrouter/qwen/qwen3-coder')).toBe(true);
  });

  test('rejects Claude aliases', () => {
    expect(isPiModelCompatible('sonnet')).toBe(false);
    expect(isPiModelCompatible('opus')).toBe(false);
    expect(isPiModelCompatible('haiku')).toBe(false);
  });

  test('rejects claude-prefixed models without provider', () => {
    expect(isPiModelCompatible('claude-sonnet-4')).toBe(false);
  });
});
