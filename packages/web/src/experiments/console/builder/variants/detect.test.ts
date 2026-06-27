import { describe, test, expect } from 'bun:test';
import { detectVariant } from './detect';
import type { VariantId, WireDagNode } from '../types';

describe('detectVariant', () => {
  test('resolves all eight variants by mode-field presence', () => {
    const cases: Array<[WireDagNode, VariantId]> = [
      [{ id: 'a', prompt: 'hi' }, 'prompt'],
      [{ id: 'a', command: 'do-thing' }, 'command'],
      [{ id: 'a', bash: 'echo hi' }, 'bash'],
      [{ id: 'a', script: 'process.stdout.write("1")', runtime: 'bun' }, 'script'],
      [
        {
          id: 'a',
          route_loop: {
            from: 'review',
            condition: "$review.output.status == 'approved'",
            max_iterations: 3,
            routes: { positive: 'done', negative: 'fix', exhausted: 'escalate' },
          },
        },
        'route_loop',
      ],
      [
        { id: 'a', loop: { prompt: 'p', until: 'DONE', max_iterations: 3, fresh_context: false } },
        'loop',
      ],
      [{ id: 'a', approval: { message: 'ok?' } }, 'approval'],
      [{ id: 'a', cancel: 'stop' }, 'cancel'],
    ];
    for (const [node, expected] of cases) {
      expect(detectVariant(node)).toBe(expected);
    }
  });

  test('defaults to prompt when no mode field is present', () => {
    expect(detectVariant({ id: 'bare' } as WireDagNode)).toBe('prompt');
  });

  test('priority order: route_loop wins over later discriminants when ambiguous', () => {
    // Malformed (mutually-exclusive fields should not co-occur), but detection
    // must be deterministic. route_loop has highest priority.
    const node = {
      id: 'a',
      route_loop: {
        from: 'review',
        condition: "$review.output.status == 'approved'",
        max_iterations: 3,
        routes: { positive: 'done', negative: 'fix', exhausted: 'escalate' },
      },
      loop: { prompt: 'p', until: 'DONE', max_iterations: 1, fresh_context: false },
      prompt: 'also here',
    } as WireDagNode;
    expect(detectVariant(node)).toBe('route_loop');
  });

  test('cancel resolves ahead of bash/script/command/prompt', () => {
    const node = { id: 'a', cancel: 'stop', prompt: 'x' } as WireDagNode;
    expect(detectVariant(node)).toBe('cancel');
  });
});
