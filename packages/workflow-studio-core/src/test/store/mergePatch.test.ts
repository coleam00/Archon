import { describe, it, expect } from 'bun:test';
import { mergePatch } from '../../store/mergePatch';

describe('mergePatch', () => {
  it('deep-merges nested objects', () => {
    const base = { model_settings: { temperature: 0.2, top_p: 0.9 }, _unknown: { future_key: 1 } };
    const patch = { model_settings: { temperature: 0.7 } };
    expect(mergePatch(base, patch)).toEqual({
      model_settings: { temperature: 0.7, top_p: 0.9 },
      _unknown: { future_key: 1 },
    });
  });

  it('replaces arrays wholesale (does NOT merge by index)', () => {
    const base = { allowed_tools: ['Read', 'Edit', 'Bash'] };
    const patch = { allowed_tools: ['Read'] };
    expect(mergePatch(base, patch)).toEqual({ allowed_tools: ['Read'] });
  });

  it('preserves _unknown subkeys when patch touches a sibling field', () => {
    const base = { description: 'old', _unknown: { foreign: { nested: 'keep me' } } };
    const patch = { description: 'new' };
    expect(mergePatch(base, patch)).toEqual({
      description: 'new',
      _unknown: { foreign: { nested: 'keep me' } },
    });
  });

  it('explicit null in patch deletes the key', () => {
    const base = { timeout: 30, retry: { max: 3 } };
    const patch = { timeout: null };
    expect(mergePatch(base, patch)).toEqual({ retry: { max: 3 } });
  });
});
