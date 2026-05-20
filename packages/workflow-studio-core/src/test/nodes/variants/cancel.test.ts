import { describe, it, expect } from 'bun:test';
import { cancelVariant } from '../../../nodes/cancel';

describe('cancel variant', () => {
  it('createDefault returns valid empty CancelNodeData', () => {
    const d = cancelVariant.createDefault();
    expect(d.cancel).toBe('');
  });

  it('fromDag extracts the cancel reason verbatim', () => {
    const data = cancelVariant.fromDag({
      base: { id: 'a' },
      variantSpecific: { cancel: 'abort' },
      raw: { id: 'a', cancel: 'abort' } as never,
    });
    expect(data).toEqual({ cancel: 'abort' });
  });

  it('fromDag does NOT trim on import (preserves the wire shape)', () => {
    const data = cancelVariant.fromDag({
      base: { id: 'a' },
      variantSpecific: { cancel: '  whitespace  ' },
      raw: { id: 'a', cancel: '  whitespace  ' } as never,
    });
    expect(data).toEqual({ cancel: '  whitespace  ' });
  });

  it('toDag trims the reason (matches Archon transform)', () => {
    expect(cancelVariant.toDag({ cancel: '  abort  ' })).toEqual({ cancel: 'abort' });
  });

  it('declares honorsAiFields = false and forbidsRetry = false', () => {
    expect(cancelVariant.capabilities.honorsAiFields).toBe(false);
    expect(cancelVariant.capabilities.forbidsRetry).toBe(false);
  });

  it('declares library metadata', () => {
    expect(cancelVariant.library.label).toBe('Cancel');
    expect(cancelVariant.library.colorToken).toBe('node-cancel');
    expect(cancelVariant.library.defaultIdHint).toBe('cancel');
  });
});
