import { describe, test, expect } from 'bun:test';
import { VARIANTS, VARIANT_REGISTRY, isVariantId } from './registry';
import { wireKeysWithRole } from '../types';
import { waitToDag } from './wait';

describe('isVariantId', () => {
  test('accepts every canonical variant id', () => {
    for (const variant of VARIANTS) {
      expect(isVariantId(variant)).toBe(true);
    }
  });

  test('rejects unknown strings (e.g. a foreign drag payload)', () => {
    for (const bad of ['', 'Prompt', 'workflow', 'node', 'application/json', 'loop ']) {
      expect(isVariantId(bad)).toBe(false);
    }
  });
});

describe('variant wire keys', () => {
  test('every wire key marked as a variant key is carried by at least one variant', () => {
    // A key given the `variant` role but listed by no variant would be dropped on save
    // with only a warning, which is the loss the role record exists to prevent.
    const carried = new Set<string>(VARIANTS.flatMap(v => [...VARIANT_REGISTRY[v].wireKeys]));
    expect(wireKeysWithRole('variant').filter(key => !carried.has(key))).toEqual([]);
  });
});

describe('wait draft serialization', () => {
  test('keeps clear duration and deadline edits renderable for validation', () => {
    expect(waitToDag({ duration_ms: undefined })).toEqual({ wait: { duration_ms: undefined } });
    expect(waitToDag({ event: 'checks.complete', deadline_ms: undefined })).toEqual({
      wait: { event: 'checks.complete', deadline_ms: undefined },
    });
  });
});
