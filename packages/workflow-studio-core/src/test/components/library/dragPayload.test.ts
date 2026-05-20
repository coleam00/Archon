import { describe, it, expect } from 'bun:test';
import {
  encodeLibraryDrag,
  decodeLibraryDrag,
  LIBRARY_DRAG_MIME,
  type LibraryDragPayload,
} from '../../../components/library/dragPayload';

describe('library drag payload', () => {
  it('round-trips a variant payload', () => {
    const p: LibraryDragPayload = { kind: 'variant', variantId: 'loop' };
    expect(decodeLibraryDrag(encodeLibraryDrag(p))).toEqual(p);
  });

  it('round-trips a command payload with prefill', () => {
    const p: LibraryDragPayload = {
      kind: 'variant',
      variantId: 'command',
      prefill: { command: 'classify' },
    };
    expect(decodeLibraryDrag(encodeLibraryDrag(p))).toEqual(p);
  });

  it('round-trips a command payload with prefill AND idHintOverride', () => {
    const p: LibraryDragPayload = {
      kind: 'variant',
      variantId: 'command',
      idHintOverride: 'run-classify',
      prefill: { command: 'classify' },
    };
    expect(decodeLibraryDrag(encodeLibraryDrag(p))).toEqual(p);
  });

  it('round-trips a snippet payload', () => {
    const p: LibraryDragPayload = {
      kind: 'snippet',
      category: 'starters',
      name: 'archon-feature-development',
    };
    expect(decodeLibraryDrag(encodeLibraryDrag(p))).toEqual(p);
  });

  it('returns null on garbage', () => {
    expect(decodeLibraryDrag('not-json')).toBeNull();
    expect(decodeLibraryDrag('{}')).toBeNull();
    expect(decodeLibraryDrag('{"kind":"unknown"}')).toBeNull();
  });

  it('exposes the MIME constant', () => {
    expect(LIBRARY_DRAG_MIME).toBe('application/x-archon-studio');
  });
});
