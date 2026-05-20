import { describe, it, expect } from 'bun:test';
import { scriptVariant } from '../../../nodes/script';

describe('script variant', () => {
  it('createDefault returns valid ScriptNodeData with runtime="bun"', () => {
    const d = scriptVariant.createDefault();
    expect(d.script).toBe('');
    expect(d.runtime).toBe('bun');
    expect(d.deps).toBeUndefined();
    expect(d.timeout).toBeUndefined();
  });

  it('fromDag extracts script + runtime', () => {
    const data = scriptVariant.fromDag({
      base: { id: 'a' },
      variantSpecific: { script: 'export {}', runtime: 'bun' },
      raw: { id: 'a', script: 'export {}', runtime: 'bun' } as never,
    });
    expect(data).toEqual({ script: 'export {}', runtime: 'bun' });
  });

  it('fromDag carries through deps and timeout', () => {
    const data = scriptVariant.fromDag({
      base: { id: 'a' },
      variantSpecific: { script: 'x', runtime: 'uv', deps: ['requests'], timeout: 3000 },
      raw: { id: 'a', script: 'x', runtime: 'uv', deps: ['requests'], timeout: 3000 } as never,
    });
    expect(data).toEqual({ script: 'x', runtime: 'uv', deps: ['requests'], timeout: 3000 });
  });

  it('toDag produces required fields when no optionals', () => {
    const result = scriptVariant.toDag({ script: 'x', runtime: 'bun' });
    expect(result).toEqual({ script: 'x', runtime: 'bun' });
    expect('deps' in result).toBe(false);
    expect('timeout' in result).toBe(false);
  });

  it('toDag emits all four fields when present', () => {
    const result = scriptVariant.toDag({
      script: 'import requests',
      runtime: 'uv',
      deps: ['requests', 'flask'],
      timeout: 5000,
    });
    expect(result).toEqual({
      script: 'import requests',
      runtime: 'uv',
      deps: ['requests', 'flask'],
      timeout: 5000,
    });
  });

  it('declares honorsAiFields = false and forbidsRetry = false', () => {
    expect(scriptVariant.capabilities.honorsAiFields).toBe(false);
    expect(scriptVariant.capabilities.forbidsRetry).toBe(false);
  });

  it('declares library metadata', () => {
    expect(scriptVariant.library.label).toBe('Script');
    expect(scriptVariant.library.colorToken).toBe('node-script');
    expect(scriptVariant.library.defaultIdHint).toBe('script');
  });

  it('round-trips toDag(fromDag(...)) preserving all four fields', () => {
    const original = {
      script: 'print("hello")',
      runtime: 'uv',
      deps: ['pandas'],
      timeout: 2000,
    };
    const fromDagResult = scriptVariant.fromDag({
      base: { id: 'a' },
      variantSpecific: original,
      raw: { id: 'a', ...original } as never,
    });
    const toDagResult = scriptVariant.toDag(fromDagResult);
    expect(toDagResult).toEqual(original);
  });
});
