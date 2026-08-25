import { describe, test, expect } from 'bun:test';
import { VARIANTS, isVariantId } from './registry';
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

describe('wait draft serialization', () => {
  test('keeps clear duration and deadline edits renderable for validation', () => {
    expect(waitToDag({ duration_ms: undefined })).toEqual({ wait: { duration_ms: undefined } });
    expect(waitToDag({ event: 'checks.complete', deadline_ms: undefined })).toEqual({
      wait: { event: 'checks.complete', deadline_ms: undefined },
    });
  });
});
