import { describe, it, expect } from 'bun:test';
import { promptVariant } from '../../../nodes/prompt';

describe('prompt variant', () => {
  it('createDefault returns a non-empty placeholder so the node passes server-tier validation', () => {
    // dagNodeSchema.superRefine rejects empty `prompt`, so a freshly-dropped
    // node must have something here — see createPromptDefault in nodes/prompt/data.ts.
    const d = promptVariant.createDefault();
    expect(d.prompt.length).toBeGreaterThan(0);
  });

  it('fromDag extracts the prompt body', () => {
    const data = promptVariant.fromDag({
      base: { id: 'a' },
      variantSpecific: { prompt: 'do it' },
      raw: { id: 'a', prompt: 'do it' } as never,
    });
    expect(data).toEqual({ prompt: 'do it' });
  });

  it('toDag produces { prompt }', () => {
    expect(promptVariant.toDag({ prompt: 'do it' })).toEqual({ prompt: 'do it' });
  });

  it('declares honorsAiFields = true and forbidsRetry = false', () => {
    expect(promptVariant.capabilities.honorsAiFields).toBe(true);
    expect(promptVariant.capabilities.forbidsRetry).toBe(false);
  });

  it('declares library metadata with label and colorToken', () => {
    expect(promptVariant.library.label).toBe('Prompt');
    expect(promptVariant.library.colorToken).toBe('node-prompt');
    expect(promptVariant.library.defaultIdHint).toBe('prompt');
  });

  it('round-trips toDag(fromDag(...)) preserving the prompt body', () => {
    const fromDagInput = {
      base: { id: 'a' },
      variantSpecific: { prompt: 'do it' },
      raw: { id: 'a', prompt: 'do it' } as never,
    };
    const data = promptVariant.fromDag(fromDagInput);
    expect(promptVariant.toDag(data)).toEqual({ prompt: 'do it' });
  });
});
