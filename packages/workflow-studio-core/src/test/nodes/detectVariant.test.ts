import { describe, it, expect } from 'bun:test';
import { detectVariant } from '../../nodes/shared/detectVariant';

describe('detectVariant', () => {
  it.each([
    ['command', { id: 'a', command: 'foo' }],
    ['prompt', { id: 'a', prompt: 'do it' }],
    ['bash', { id: 'a', bash: 'echo hi' }],
    ['script', { id: 'a', script: 'console.log(1)', runtime: 'bun' }],
    ['loop', { id: 'a', loop: { prompt: 'p', until: 'DONE', max_iterations: 1 } }],
    ['approval', { id: 'a', approval: { message: 'ok?' } }],
    ['cancel', { id: 'a', cancel: 'abort' }],
  ])('detects %s', (expected, raw) => {
    expect(detectVariant(raw)).toEqual({ ok: true, variant: expected });
  });

  it('reports zero-variant nodes', () => {
    expect(detectVariant({ id: 'a' })).toEqual({ ok: false, reason: 'no-variant-key' });
  });

  it('reports multi-variant nodes', () => {
    expect(detectVariant({ id: 'a', command: 'foo', prompt: 'bar' })).toEqual({
      ok: false,
      reason: 'multiple-variant-keys',
      keysPresent: ['command', 'prompt'],
    });
  });

  it('treats empty-string command/prompt/bash/script/cancel as absent (matches Archon)', () => {
    expect(detectVariant({ id: 'a', command: '', prompt: 'real' })).toEqual({
      ok: true,
      variant: 'prompt',
    });
  });
});
