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

  test('allows custom OMP provider ids for SDK resolution', () => {
    expect(parseOmpModelRef('my_provider/foo')).toEqual({
      provider: 'my_provider',
      modelId: 'foo',
    });
  });

  test('normalizes provider id casing before SDK and env lookup', () => {
    expect(parseOmpModelRef('Anthropic/claude')).toEqual({
      provider: 'anthropic',
      modelId: 'claude',
    });
  });

  test('rejects malformed refs', () => {
    expect(parseOmpModelRef('')).toBeUndefined();
    expect(parseOmpModelRef('anthropic')).toBeUndefined();
    expect(parseOmpModelRef('/model')).toBeUndefined();
    expect(parseOmpModelRef('anthropic/')).toBeUndefined();
    expect(parseOmpModelRef(' /model')).toBeUndefined();
  });
});
