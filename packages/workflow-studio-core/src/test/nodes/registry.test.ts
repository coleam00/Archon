import { describe, it, expect } from 'bun:test';
import { VARIANT_IDS } from '../../nodes/registry';

import { defaultRegistry, getVariant } from '../../nodes/default-registry';

describe('default variant registry', () => {
  it('contains all 7 variant ids', () => {
    for (const id of VARIANT_IDS) {
      expect(defaultRegistry[id]).toBeDefined();
      expect(defaultRegistry[id].id).toBe(id);
    }
  });

  it('exposes a variant by id', () => {
    expect(getVariant('command').id).toBe('command');
    expect(getVariant('cancel').id).toBe('cancel');
  });

  it('every variant has capabilities + library metadata + schema + createDefault + fromDag + toDag', () => {
    for (const id of VARIANT_IDS) {
      const v = getVariant(id);
      expect(v.capabilities).toBeDefined();
      expect(v.library.label).toBeTruthy();
      expect(v.library.colorToken).toBeTruthy();
      expect(typeof v.createDefault).toBe('function');
      expect(typeof v.fromDag).toBe('function');
      expect(typeof v.toDag).toBe('function');
    }
  });
});
