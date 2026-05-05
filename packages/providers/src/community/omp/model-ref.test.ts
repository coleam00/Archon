import { describe, expect, test } from 'bun:test';

import { parseOmpModelRef } from './model-ref';

describe('parseOmpModelRef', () => {
  test('parses provider and model id', () => {
    expect(parseOmpModelRef('anthropic/claude-sonnet-4-5')).toEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-5',
    });
  });

  test('preserves nested model ids', () => {
    expect(parseOmpModelRef('openrouter/qwen/qwen3-coder')).toEqual({
      provider: 'openrouter',
      modelId: 'qwen/qwen3-coder',
    });
  });

  test('allows dotted OMP provider ids', () => {
    expect(parseOmpModelRef('llama.cpp/qwen2.5-coder')).toEqual({
      provider: 'llama.cpp',
      modelId: 'qwen2.5-coder',
    });
  });

  test('rejects malformed refs', () => {
    expect(parseOmpModelRef('')).toBeUndefined();
    expect(parseOmpModelRef('anthropic')).toBeUndefined();
    expect(parseOmpModelRef('/model')).toBeUndefined();
    expect(parseOmpModelRef('anthropic/')).toBeUndefined();
    expect(parseOmpModelRef('Anthropic/claude')).toBeUndefined();
    expect(parseOmpModelRef('anthropic_beta/claude')).toBeUndefined();
    expect(parseOmpModelRef('anthropic..beta/claude')).toBeUndefined();
    expect(parseOmpModelRef('anthropic./claude')).toBeUndefined();
  });
});
