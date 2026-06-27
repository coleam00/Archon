import { describe, it, expect } from 'bun:test';

import {
  declaredFieldsFromSchema,
  latestCompletedNodeOutput,
  OutputRefError,
  resolveNodeOutputField,
} from './output-ref';
import type { NodeOutputAttempt } from './output-ref';
import type { NodeOutput } from './schemas';

function completed(
  output: string,
  structuredOutput?: unknown,
  declaredFields?: string[]
): NodeOutput {
  return {
    state: 'completed',
    output,
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    ...(declaredFields !== undefined ? { declaredFields } : {}),
  };
}

describe('declaredFieldsFromSchema', () => {
  it('returns the property names for an object schema', () => {
    expect(declaredFieldsFromSchema({ type: 'object', properties: { a: {}, b: {} } })).toEqual([
      'a',
      'b',
    ]);
  });

  it('returns [] for an explicit empty properties map', () => {
    expect(declaredFieldsFromSchema({ type: 'object', properties: {} })).toEqual([]);
  });

  it('returns undefined when there is no schema', () => {
    expect(declaredFieldsFromSchema(undefined)).toBeUndefined();
  });

  it('returns undefined for a non-object schema (no properties map)', () => {
    expect(declaredFieldsFromSchema({ type: 'array', items: {} })).toBeUndefined();
    expect(declaredFieldsFromSchema({ type: 'string' })).toBeUndefined();
  });

  it('returns undefined when properties is explicitly null', () => {
    expect(declaredFieldsFromSchema({ type: 'object', properties: null })).toBeUndefined();
  });
});

describe('latestCompletedNodeOutput - attempt projection for $node.output', () => {
  it('resolves $node.output to the highest numbered completed attempt', () => {
    const attempts: NodeOutputAttempt[] = [
      { attempt: 1, output: completed('first review') },
      { attempt: 3, output: completed('third review') },
      { attempt: 2, output: completed('second review') },
    ];

    expect(latestCompletedNodeOutput(attempts)?.output).toBe('third review');
  });

  it('ignores newer non-completed attempts when resolving $node.output', () => {
    const attempts: NodeOutputAttempt[] = [
      { attempt: 1, output: completed('last good review') },
      { attempt: 2, output: { state: 'failed', output: '', error: 'review failed' } },
      { attempt: 3, output: { state: 'skipped', output: '' } },
      { attempt: 4, output: { state: 'pending', output: '' } },
    ];

    expect(latestCompletedNodeOutput(attempts)?.output).toBe('last good review');
  });

  it('returns undefined when no completed attempt exists', () => {
    const attempts: NodeOutputAttempt[] = [
      { attempt: 1, output: { state: 'failed', output: '', error: 'review failed' } },
      { attempt: 2, output: { state: 'skipped', output: '' } },
    ];

    expect(latestCompletedNodeOutput(attempts)).toBeUndefined();
  });

  it('resolves fields from the latest completed attempt output contract', () => {
    const attempts: NodeOutputAttempt[] = [
      {
        attempt: 1,
        output: completed('{"result":"negative"}', { result: 'negative' }, ['result']),
      },
      {
        attempt: 2,
        output: completed('{"result":"positive"}', { result: 'positive' }, ['result']),
      },
    ];
    const latest = latestCompletedNodeOutput(attempts);

    if (latest === undefined) throw new Error('expected latest completed attempt');
    expect(resolveNodeOutputField(latest, 'review', 'result')).toEqual({
      kind: 'value',
      value: 'positive',
    });
  });
});

describe('resolveNodeOutputField — producer did not run', () => {
  it('throws producer-not-run for a skipped producer (clear message, not "unparseable")', () => {
    try {
      resolveNodeOutputField({ state: 'skipped', output: '' }, 'n', 'field');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(OutputRefError);
      expect((e as OutputRefError).reason).toBe('producer-not-run');
    }
  });

  it('throws producer-not-run for a pending producer', () => {
    expect(() => resolveNodeOutputField({ state: 'pending', output: '' }, 'n', 'field')).toThrow(
      OutputRefError
    );
  });
});

describe('resolveNodeOutputField — declared-schema producer', () => {
  const declared = ['type', 'note'];

  it('resolves a present declared field from structuredOutput', () => {
    const r = resolveNodeOutputField(
      completed('{"type":"BUG"}', { type: 'BUG' }, declared),
      'n',
      'type'
    );
    expect(r).toEqual({ kind: 'value', value: 'BUG' });
  });

  it('declared-optional absent field → empty (not a throw)', () => {
    const r = resolveNodeOutputField(
      completed('{"type":"BUG"}', { type: 'BUG' }, declared),
      'n',
      'note'
    );
    expect(r).toEqual({ kind: 'empty' });
  });

  it('explicit null on a declared field → empty', () => {
    const r = resolveNodeOutputField(
      completed('{"type":null}', { type: null }, declared),
      'n',
      'type'
    );
    expect(r).toEqual({ kind: 'empty' });
  });

  it('field not in the declared schema → throws not-in-schema', () => {
    expect(() =>
      resolveNodeOutputField(completed('{"type":"BUG"}', { type: 'BUG' }, ['type']), 'n', 'tpye')
    ).toThrow(OutputRefError);
    try {
      resolveNodeOutputField(completed('{"type":"BUG"}', { type: 'BUG' }, ['type']), 'n', 'tpye');
    } catch (e) {
      expect((e as OutputRefError).reason).toBe('not-in-schema');
    }
  });

  it('falls back to parsing output when structuredOutput is absent (legacy declared row)', () => {
    const r = resolveNodeOutputField(completed('{"type":"BUG"}', undefined, ['type']), 'n', 'type');
    expect(r).toEqual({ kind: 'value', value: 'BUG' });
  });
});

describe('resolveNodeOutputField — structuredOutput without a declared schema (lenient)', () => {
  it('resolves a present field', () => {
    const r = resolveNodeOutputField(completed('prose', { type: 'BUG' }), 'n', 'type');
    expect(r).toEqual({ kind: 'value', value: 'BUG' });
  });

  it('absent field → empty (no throw — cannot enforce a contract we do not have)', () => {
    const r = resolveNodeOutputField(completed('prose', { type: 'BUG' }), 'n', 'missing');
    expect(r).toEqual({ kind: 'empty' });
  });

  it('present null is kept as a value (callers stringify to "null")', () => {
    const r = resolveNodeOutputField(completed('prose', { type: null }), 'n', 'type');
    expect(r).toEqual({ kind: 'value', value: null });
  });

  it('non-object structuredOutput falls through to the schemaless path', () => {
    // structuredOutput is an array → not a usable object → parse output instead.
    const r = resolveNodeOutputField(completed('{"type":"BUG"}', [1, 2, 3]), 'n', 'type');
    expect(r).toEqual({ kind: 'value', value: 'BUG' });
  });
});

describe('resolveNodeOutputField — schemaless producer (bash/script/prose)', () => {
  it('resolves a present key from JSON output', () => {
    const r = resolveNodeOutputField(completed('{"status":"done"}'), 'n', 'status');
    expect(r).toEqual({ kind: 'value', value: 'done' });
  });

  it('strips a code fence before parsing', () => {
    const r = resolveNodeOutputField(completed('```json\n{"status":"done"}\n```'), 'n', 'status');
    expect(r).toEqual({ kind: 'value', value: 'done' });
  });

  it('non-JSON output → throws unparseable', () => {
    try {
      resolveNodeOutputField(completed('just prose'), 'n', 'status');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(OutputRefError);
      expect((e as OutputRefError).reason).toBe('unparseable');
    }
  });

  it('valid JSON but missing key → throws missing-key', () => {
    try {
      resolveNodeOutputField(completed('{"status":"done"}'), 'n', 'other');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(OutputRefError);
      expect((e as OutputRefError).reason).toBe('missing-key');
    }
  });

  it('top-level JSON array → throws unparseable (no named fields)', () => {
    expect(() => resolveNodeOutputField(completed('[1,2,3]'), 'n', 'x')).toThrow(OutputRefError);
  });
});
