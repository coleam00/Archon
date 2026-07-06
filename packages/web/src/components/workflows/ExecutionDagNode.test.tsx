import { describe, expect, test } from 'bun:test';

import { formatRuntimeMetadata } from './ExecutionDagNode';

describe('formatRuntimeMetadata', () => {
  test('formats provider, model, and reasoning effort', () => {
    expect(
      formatRuntimeMetadata({
        provider: 'claude',
        model: 'sonnet',
        modelReasoningEffort: 'xhigh',
      })
    ).toBe('claude - sonnet - xhigh');
  });

  test('omits metadata when provider is absent', () => {
    expect(formatRuntimeMetadata({ model: 'sonnet', modelReasoningEffort: 'xhigh' })).toBeNull();
  });

  test('falls back to thinking metadata when no effort is present', () => {
    expect(
      formatRuntimeMetadata({
        provider: 'claude',
        model: 'sonnet',
        thinking: { type: 'enabled', budgetTokens: 4000 },
      })
    ).toBe('claude - sonnet - enabled 4000');
  });
});
