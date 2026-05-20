import { describe, it, expect } from 'bun:test';
import { pickBaseFields } from '../../nodes/shared/pickBaseFields';

describe('pickBaseFields', () => {
  it('partitions a bash node into base + variant-specific + unknown', () => {
    const raw = {
      id: 'do-thing',
      depends_on: ['parent'],
      bash: 'echo hi',
      timeout: 5000,
      __experimental_flag: true, // unknown
      future_field: { nested: 1 }, // unknown
    };
    expect(pickBaseFields(raw, 'bash')).toEqual({
      base: { id: 'do-thing', depends_on: ['parent'] },
      variantSpecific: { bash: 'echo hi', timeout: 5000 },
      unknown: { __experimental_flag: true, future_field: { nested: 1 } },
    });
  });

  it('partitions a command node with full AI fields', () => {
    const raw = {
      id: 'classify',
      command: 'classify',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      output_format: { schema: { type: 'object' } },
      ai_v2_brand_new: 'placeholder',
    };
    const result = pickBaseFields(raw, 'command');
    expect(result.base).toEqual({
      id: 'classify',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      output_format: { schema: { type: 'object' } },
    });
    expect(result.variantSpecific).toEqual({ command: 'classify' });
    expect(result.unknown).toEqual({ ai_v2_brand_new: 'placeholder' });
  });

  it('preserves nested foreign keys inside known objects in the unknown bag (top-level only here)', () => {
    // pickBaseFields partitions only the top level. Nested-object preservation
    // is handled by per-variant fromDag/toDag (§6.3 deep-merge contract).
    const raw = { id: 'a', loop: { prompt: 'p', until: 'X', max_iterations: 1, future_knob: 7 } };
    const result = pickBaseFields(raw, 'loop');
    expect(result.unknown).toEqual({});
    expect(result.variantSpecific).toEqual({
      loop: { prompt: 'p', until: 'X', max_iterations: 1, future_knob: 7 },
    });
  });
});
