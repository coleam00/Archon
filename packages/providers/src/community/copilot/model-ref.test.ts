import { describe, expect, test } from 'bun:test';

import { isCopilotModelCompatible } from './model-ref';

describe('isCopilotModelCompatible', () => {
  test('accepts typical Copilot model names', () => {
    expect(isCopilotModelCompatible('gpt-5')).toBe(true);
    expect(isCopilotModelCompatible('gpt-5-mini')).toBe(true);
    expect(isCopilotModelCompatible('gpt-4.1')).toBe(true);
    expect(isCopilotModelCompatible('o1')).toBe(true);
  });

  test('accepts Anthropic BYOK model names (versioned)', () => {
    expect(isCopilotModelCompatible('claude-sonnet-4.5')).toBe(true);
    expect(isCopilotModelCompatible('claude-opus-4.6')).toBe(true);
    expect(isCopilotModelCompatible('claude-haiku-4-5')).toBe(true);
  });

  test('rejects Claude short aliases', () => {
    expect(isCopilotModelCompatible('sonnet')).toBe(false);
    expect(isCopilotModelCompatible('opus')).toBe(false);
    expect(isCopilotModelCompatible('haiku')).toBe(false);
  });

  test('rejects `inherit` sentinel', () => {
    expect(isCopilotModelCompatible('inherit')).toBe(false);
  });

  test('rejects empty or whitespace-only strings', () => {
    expect(isCopilotModelCompatible('')).toBe(false);
    expect(isCopilotModelCompatible('   ')).toBe(false);
    expect(isCopilotModelCompatible('\t')).toBe(false);
  });

  test('accepts openrouter-style nested slugs (Copilot BYOK path)', () => {
    expect(isCopilotModelCompatible('openrouter/qwen/qwen3-coder')).toBe(true);
  });
});
