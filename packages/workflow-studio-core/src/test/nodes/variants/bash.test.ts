import { describe, it, expect } from 'bun:test';
import { bashVariant } from '../../../nodes/bash';

describe('bash variant', () => {
  it('createDefault returns valid empty BashNodeData with no timeout', () => {
    const d = bashVariant.createDefault();
    expect(d.bash).toBe('');
    expect(d.timeout).toBeUndefined();
  });

  it('fromDag extracts the bash body', () => {
    const data = bashVariant.fromDag({
      base: { id: 'a' },
      variantSpecific: { bash: 'echo hi' },
      raw: { id: 'a', bash: 'echo hi' } as never,
    });
    expect(data).toEqual({ bash: 'echo hi' });
  });

  it('fromDag extracts the bash body and timeout', () => {
    const data = bashVariant.fromDag({
      base: { id: 'a' },
      variantSpecific: { bash: 'echo hi', timeout: 5000 },
      raw: { id: 'a', bash: 'echo hi', timeout: 5000 } as never,
    });
    expect(data).toEqual({ bash: 'echo hi', timeout: 5000 });
  });

  it('toDag produces { bash } when timeout omitted', () => {
    expect(bashVariant.toDag({ bash: 'echo hi' })).toEqual({ bash: 'echo hi' });
  });

  it('toDag produces { bash, timeout } when timeout defined', () => {
    expect(bashVariant.toDag({ bash: 'echo hi', timeout: 5000 })).toEqual({
      bash: 'echo hi',
      timeout: 5000,
    });
  });

  it('declares honorsAiFields = false and forbidsRetry = false', () => {
    expect(bashVariant.capabilities.honorsAiFields).toBe(false);
    expect(bashVariant.capabilities.forbidsRetry).toBe(false);
  });

  it('declares library metadata with label and colorToken', () => {
    expect(bashVariant.library.label).toBe('Bash');
    expect(bashVariant.library.colorToken).toBe('node-bash');
    expect(bashVariant.library.defaultIdHint).toBe('bash');
  });
});
