import { describe, expect, test } from 'bun:test';

import { parseOmpModelRef } from './model-ref';

describe('parseOmpModelRef', () => {
  test('parses simple provider/model', () => {
    expect(parseOmpModelRef('cursor/composer-2.5')).toEqual({
      provider: 'cursor',
      modelId: 'composer-2.5',
    });
  });

  test('preserves nested slashes in modelId', () => {
    expect(parseOmpModelRef('openrouter/qwen/qwen3-coder')).toEqual({
      provider: 'openrouter',
      modelId: 'qwen/qwen3-coder',
    });
  });

  test('accepts hyphens in provider slug', () => {
    expect(parseOmpModelRef('minimax-token-plan/MiniMax-M3')).toEqual({
      provider: 'minimax-token-plan',
      modelId: 'MiniMax-M3',
    });
  });

  test('rejects legacy underscore provider ids', () => {
    expect(parseOmpModelRef('minimax_m3/minimax-m3')).toBeUndefined();
  });

  test('rejects missing slash', () => {
    expect(parseOmpModelRef('sonnet')).toBeUndefined();
  });
});
